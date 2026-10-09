#!/usr/bin/env python3
"""Offline planetary DEM tooling: inspect, fuse, tile (issue #50).

    dem.py inspect RASTER...
    dem.py fuse  --base GLOBAL.tif --detail REGIONAL.tif --out DIR [--blend-m 1000]
    dem.py tile  --base GLOBAL.tif --fusion DIR --out PYRAMID [--global-zoom 9 --max-zoom 15]
    dem.py polar-tile --base GLOBAL.tif --fusion DIR --out TILESET [--max-level 7]
    dem.py selftest

`fuse` treats the regional DEM as detail over the canonical global DEM, never as
a replacement: it fits and discloses a planar registration bias (removing it unless told to keep it),
and tapers the remaining residual to zero across a blend band inside the detail
coverage. `tile` writes ONE quantized-mesh-1.0 pyramid from
height = base(lon, lat) + residual(lon, lat), sampling the base with one
Catmull-Rom kernel (in fuse and at every tile level alike) and the residual
bilinearly. Same-LOD shared edges therefore carry identical
vertices and heights by construction, and the coverage boundary is invisible in
the height field because the residual is already zero there.

Tile-level validation (edges, parent/child, registration, control points) runs
on the written pyramid with the viewer's own decoder: scripts/validate-terrain.mjs.

The detail may also be polar stereographic (e.g. LOLA south-pole mosaics). Its
residual then stays on its own x/y grid, and inside the detail coverage the tiled
height is weight·base_xy + (1 − weight)·base(lon, lat) + residual, with base_xy
the base resampled onto the detail grid: where the weight is 1 the surface is the
detail exactly, and at the pole it is single-valued instead of inheriting the
lon/lat base kernel's longitude-dependent value there.

The base may be geographic or 0°/0° equirectangular, with GDAL band
scale/offset honoured (the LOLA LDEM stores Int16 half-metres).

Requires GDAL's Python bindings and numpy (`brew install gdal` provides both).
Heights keep the sources' vertical datum; nothing is re-referenced here.
"""
import argparse, gzip, json, math, multiprocessing as mp, os, struct, sys, time
import numpy as np
from osgeo import gdal

gdal.UseExceptions()

# ---------------------------------------------------------------------------
# Rasters

def raster_info(path):
    ds = gdal.Open(path)
    gt, b = ds.GetGeoTransform(), ds.GetRasterBand(1)
    srs = ds.GetSpatialRef()
    return {
        'path': os.path.abspath(path),
        'size': [ds.RasterXSize, ds.RasterYSize],
        'geotransform': list(gt),
        'bounds': [gt[0], gt[3] + gt[5] * ds.RasterYSize, gt[0] + gt[1] * ds.RasterXSize, gt[3]],
        'crs': srs.ExportToProj4() if srs else None,
        'semiMajorM': srs.GetSemiMajor() if srs else None,
        'semiMinorM': srs.GetSemiMinor() if srs else None,
        'geographic': bool(srs and srs.IsGeographic()),
        'dataType': gdal.GetDataTypeName(b.DataType),
        'nodata': b.GetNoDataValue(),
        'areaOrPoint': ds.GetMetadataItem('AREA_OR_POINT'),
        'overviews': [[b.GetOverview(i).XSize, b.GetOverview(i).YSize] for i in range(b.GetOverviewCount())],
    }


def cmd_inspect(args):
    for path in args.rasters:
        info = raster_info(path)
        ds = gdal.Open(path)
        b = ds.GetRasterBand(1)
        # Approximate stats from the coarsest overview: cheap on multi-GB sources.
        src = b.GetOverview(b.GetOverviewCount() - 1) if b.GetOverviewCount() else b
        a = src.ReadAsArray().astype(np.float64)
        nd = info['nodata']
        valid = np.isfinite(a) & (a > -1e30) & ((a != nd) if nd is not None else True)
        info['approxStats'] = {'min': float(a[valid].min()), 'max': float(a[valid].max()),
                               'mean': float(a[valid].mean()), 'validFraction': float(valid.mean())}
        print(json.dumps(info, indent=2))


def geographic_grid(ds):
    """Geographic (lon, lat) geotransform of a raster in the same body's
    geographic CRS or its 0°/0° equirectangular projection, which is linear in
    lon/lat: x = R·λ, y = R·φ. Anything else must be warped first."""
    gt, srs = ds.GetGeoTransform(), ds.GetSpatialRef()
    if srs.IsGeographic():
        return gt
    p = srs.ExportToProj4()
    if '+proj=eqc' not in p or '+lat_ts=0' not in p or '+lon_0=0' not in p:
        raise SystemExit(f'detail CRS must be geographic or eqc lat_ts=0 lon_0=0, got {p}')
    k = 180 / (math.pi * srs.GetSemiMajor())
    return (gt[0] * k, gt[1] * k, 0.0, gt[3] * k, 0.0, gt[5] * k)


class Grid:
    """A detail raster's sampling grid: geographic degrees (`kind` 'geo', any
    raster `geographic_grid` accepts) or polar stereographic metres on a
    sphere ('stere'). `project` maps lon/lat to the grid's native x/y, so the
    same pixel-is-area `bilinear` samples either."""

    def __init__(self, ds):
        srs = ds.GetSpatialRef()
        self.radius = srs.GetSemiMajor()
        self.wkt = ds.GetProjection()
        self.proj4 = srs.ExportToProj4()
        self.size = (ds.RasterXSize, ds.RasterYSize)
        p = dict(kv.split('=', 1) if '=' in kv else (kv, True) for kv in self.proj4.replace('+', '').split())
        if p.get('proj') == 'stere':
            lat0 = float(p.get('lat_0', 0))
            if abs(abs(lat0) - 90) > 1e-9 or 'lat_ts' in p or float(p.get('x_0', 0)) or float(p.get('y_0', 0)):
                raise SystemExit(f'stereographic detail must be polar (lat_0=±90, k form, no false origin), got {self.proj4}')
            if abs(srs.GetSemiMinor() - self.radius) > 1e-3:
                raise SystemExit('stereographic detail must be on a sphere')
            self.kind = 'stere'
            self.south = lat0 < 0
            self.lon0 = math.radians(float(p.get('lon_0', 0)))
            self.k0 = float(p.get('k', p.get('k_0', 1)))
            self.gt = ds.GetGeoTransform()
            self.unit_deg = 180 / (math.pi * self.radius)  # degrees per metre, at the pole
        else:
            self.kind = 'geo'
            self.gt = geographic_grid(ds)
            self.unit_deg = 1.0

    def project(self, lon, lat):
        if self.kind == 'geo':
            return lon, lat
        lam, phi = np.radians(lon) - self.lon0, np.radians(lat)
        rho = 2 * self.radius * self.k0 * np.tan(math.pi / 4 + (phi if self.south else -phi) / 2)
        return rho * np.sin(lam), (rho if self.south else -rho) * np.cos(lam)

    def unproject(self, x, y):
        if self.kind == 'geo':
            return x, y
        rho = np.hypot(x, y)
        phi = 2 * np.arctan(rho / (2 * self.radius * self.k0)) - math.pi / 2
        lam = np.arctan2(x, y if self.south else -y) + self.lon0
        lon = (np.degrees(lam) + 180) % 360 - 180
        return lon, (np.degrees(phi) if self.south else -np.degrees(phi))

    def geo_bounds(self):
        """Lon/lat box (W, S, E, N) containing the raster."""
        gt, (w, h) = self.gt, self.size
        if self.kind == 'geo':
            return (gt[0], gt[3] + gt[5] * h, gt[0] + gt[1] * w, gt[3])
        t = np.linspace(0, 1, 1025)
        xs = np.concatenate([gt[0] + t * gt[1] * w, np.full_like(t, gt[0] + gt[1] * w), gt[0] + t * gt[1] * w, np.full_like(t, gt[0])])
        ys = np.concatenate([np.full_like(t, gt[3]), gt[3] + t * gt[5] * h, np.full_like(t, gt[3] + gt[5] * h), gt[3] + t * gt[5] * h])
        _, lat = self.unproject(xs, ys)
        pole_inside = gt[0] <= 0 <= gt[0] + gt[1] * w and gt[3] + gt[5] * h <= 0 <= gt[3]
        if not pole_inside:
            raise SystemExit('stereographic detail must contain its pole')
        return (-180.0, -90.0, 180.0, float(lat.max())) if self.south else (-180.0, float(lat.min()), 180.0, 90.0)

    def pixel_m(self):
        """Nominal ground pixel size (north-south) in metres."""
        return abs(self.gt[5]) * (1 if self.kind == 'stere' else math.pi / 180 * self.radius)

    def planar_km(self):
        """Per-column and per-row planar coordinates (km) for the registration
        fit: local east/north for geographic grids, the projection's own x/y
        for stereographic ones (east/north are undefined at the pole)."""
        gt, (w, h) = self.gt, self.size
        cx = gt[0] + (np.arange(w) + 0.5) * gt[1]
        cy = gt[3] + (np.arange(h) + 0.5) * gt[5]
        if self.kind == 'stere':
            return cx / 1000, cy / 1000, 'polar stereographic x/y (km)'
        lon0, lat0 = float(cx[w // 2]), float(cy[h // 2])
        m_per_deg = math.pi / 180 * self.radius
        return ((cx - lon0) * m_per_deg * math.cos(math.radians(lat0)) / 1000,
                (cy - lat0) * m_per_deg / 1000, 'local east/north (km)')


def bilinear(arr, gt, lon, lat, wrap_lon=False, outside=None):
    """Bilinear sample of a north-up pixel-is-area raster at (lon, lat).

    The single kernel both `fuse` (base on the detail grid) and `tile` (every
    vertex) use, so base + residual reproduces fused heights exactly.
    `outside` is the value off the raster (None: clamp to the edge)."""
    h, w = arr.shape
    c = (lon - gt[0]) / gt[1] - 0.5
    r = (lat - gt[3]) / gt[5] - 0.5
    c0, r0 = np.floor(c), np.floor(r)
    fc, fr = c - c0, r - r0
    c0, r0 = c0.astype(np.int64), r0.astype(np.int64)
    c1, r1 = c0 + 1, r0 + 1
    if wrap_lon:
        c0, c1 = c0 % w, c1 % w
    else:
        c0, c1 = np.clip(c0, 0, w - 1), np.clip(c1, 0, w - 1)
    inside = None
    if outside is not None:
        inside = (c >= -0.5) & (c <= w - 0.5) & (r >= -0.5) & (r <= h - 0.5)
    r0, r1 = np.clip(r0, 0, h - 1), np.clip(r1, 0, h - 1)
    v = ((arr[r0, c0] * (1 - fc) + arr[r0, c1] * fc) * (1 - fr)
         + (arr[r1, c0] * (1 - fc) + arr[r1, c1] * fc) * fr)
    if inside is not None:
        v = np.where(inside, v, outside)
    return v


def cubic(arr, gt, lon, lat, wrap_lon=False):
    """Catmull-Rom sample of a north-up pixel-is-area raster at (lon, lat).

    The base kernel for both `fuse` and `tile`, so base + residual reproduces
    fused heights exactly. Interpolating and C1: upsampling a 200 m base to
    metre-scale tiles stays smooth instead of showing bilinear pixel facets."""
    h, w = arr.shape
    c = (lon - gt[0]) / gt[1] - 0.5
    r = (lat - gt[3]) / gt[5] - 0.5
    c0, r0 = np.floor(c), np.floor(r)
    tc, tr = c - c0, r - r0
    c0, r0 = c0.astype(np.int64), r0.astype(np.int64)

    def weights(t):
        t2, t3 = t * t, t * t * t
        return ((-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2)

    wc, wr = weights(tc), weights(tr)
    out = 0
    for j in range(4):
        rr = np.clip(r0 + j - 1, 0, h - 1)
        row = 0
        for i in range(4):
            cc = c0 + i - 1
            cc = cc % w if wrap_lon else np.clip(cc, 0, w - 1)
            row = row + arr[rr, cc] * wc[i]
        out = out + row * wr[j]
    return out


def open_base(path):
    """Full-resolution base raster as a read-only array, its geographic
    geotransform, nodata, and the band's (scale, offset): height = raw·scale + offset.

    An uncompressed, contiguous single-band strip TIFF (the USGS global
    mosaics) is memory-mapped so forked workers share the OS page cache;
    anything else is read into memory."""
    ds = gdal.Open(path)
    b = ds.GetRasterBand(1)
    w, h = ds.RasterXSize, ds.RasterYSize
    dtype = gdal.GetDataTypeName(b.DataType)
    np_dtype = {'Int16': '<i2', 'Float32': '<f4', 'UInt16': '<u2'}.get(dtype)
    off0 = b.GetMetadataItem('BLOCK_OFFSET_0_0', 'TIFF')
    offn = b.GetMetadataItem(f'BLOCK_OFFSET_0_{h - 1}', 'TIFF')
    bw, bh = b.GetBlockSize()
    compressed = ds.GetMetadataItem('COMPRESSION', 'IMAGE_STRUCTURE')
    with open(path, 'rb') as f:
        little = f.read(2) == b'II'
    if (np_dtype and off0 and offn and not compressed and little and bw == w and bh == 1
            and int(offn) - int(off0) == (h - 1) * w * np.dtype(np_dtype).itemsize):
        arr = np.memmap(path, dtype=np_dtype, mode='r', offset=int(off0), shape=(h, w))
        probe = b.ReadAsArray(0, h // 2, w, 1)[0]
        assert np.array_equal(probe, arr[h // 2]), 'memmap layout check failed'
    else:
        arr = b.ReadAsArray()
    return arr, geographic_grid(ds), b.GetNoDataValue(), (b.GetScale() or 1.0, b.GetOffset() or 0.0)


# ---------------------------------------------------------------------------
# fuse

def stats(d):
    d = np.asarray(d, dtype=np.float64)
    if d.size == 0:
        return {'n': 0}
    a = np.abs(d)
    return {'n': int(d.size), 'meanM': float(d.mean()), 'rmsM': float(np.sqrt((d * d).mean())),
            'p95AbsM': float(np.percentile(a, 95)), 'maxAbsM': float(a.max())}


def write_tif(path, arr, gt, srs_wkt, nodata=None, dtype=gdal.GDT_Float32):
    drv = gdal.GetDriverByName('GTiff')
    ds = drv.Create(path, arr.shape[1], arr.shape[0], 1, dtype,
                    ['COMPRESS=DEFLATE', 'PREDICTOR=' + ('3' if dtype == gdal.GDT_Float32 else '2'),
                     'TILED=YES', 'BIGTIFF=IF_SAFER'])
    ds.SetGeoTransform(gt)
    ds.SetProjection(srs_wkt)
    b = ds.GetRasterBand(1)
    if nodata is not None:
        b.SetNoDataValue(nodata)
    b.WriteArray(arr)
    ds = None


def cmd_fuse(args):
    t0 = time.time()
    os.makedirs(args.out, exist_ok=True)
    base_ds = gdal.Open(args.base)
    radius = base_ds.GetSpatialRef().GetSemiMajor()
    base, base_gt, base_nd, (bscale, boff) = open_base(args.base)

    det_ds = gdal.Open(args.detail)
    if abs(det_ds.GetSpatialRef().GetSemiMajor() - radius) > 1e-3:
        raise SystemExit('base and detail must share the reference body/sphere')
    grid = Grid(det_ds)
    gt = grid.gt
    db = det_ds.GetRasterBand(1)
    detail = db.ReadAsArray().astype(np.float32)
    nd = db.GetNoDataValue()
    # Real elevations on any rocky body sit well inside ±1e5 m; float-min
    # sentinels and resampling tails around them do not.
    covered = np.isfinite(detail) & (np.abs(detail) < 1e5)
    if nd is not None:
        covered &= detail != nd
    h, w = detail.shape
    print(f'detail {w}×{h}, coverage {covered.mean() * 100:.1f}% ({time.time() - t0:.0f}s)')

    gx = gt[0] + (np.arange(w) + 0.5) * gt[1]
    gy = gt[3] + (np.arange(h) + 0.5) * gt[5]
    base_on = np.empty((h, w), np.float32)
    for r0 in range(0, h, 256):  # small chunks: the cubic kernel holds 16 gathers
        yy = gy[r0:r0 + 256, None]
        lon, lat = grid.unproject(np.broadcast_to(gx, (yy.shape[0], w)), np.broadcast_to(yy, (yy.shape[0], w)))
        base_on[r0:r0 + 256] = cubic(base, base_gt, lon, lat, wrap_lon=True) * bscale + boff
    if base_nd is not None:
        # A base nodata value anywhere in a kernel would poison the fit.
        assert not np.any(base_on <= base_nd * bscale + boff + 1), 'base nodata inside detail extent'

    lon0, lat0 = (float(v) for v in grid.unproject(np.array(gx[w // 2]), np.array(gy[h // 2])))
    east_km, north_km, planar_axes = grid.planar_km()

    # Memory: detail, base_on and one distance/weight raster are the only
    # full-size arrays; the residual is formed in place in `detail`.
    step = args.fit_stride
    sub = covered[::step, ::step]
    diff_sub = (detail[::step, ::step] - base_on[::step, ::step])[sub].astype(np.float64)
    E, N = np.meshgrid(east_km[::step], north_km[::step])
    A = np.column_stack([np.ones(sub.sum()), E[sub], N[sub]])
    coef, *_ = np.linalg.lstsq(A, diff_sub, rcond=None)
    off, se, sn = (float(c) for c in coef)
    plane_sub = A @ coef
    del A, E, N
    print(f'plane: offset {off:.2f} m, slopes {se:.3f} m/km E, {sn:.3f} m/km N ({time.time() - t0:.0f}s)')

    # Pixel pairs straddling the coverage edge (inside, outside), kept as
    # indices so boundary continuity can be measured after the in-place work.
    pairs = []
    for axis in (1, 0):
        a = covered[:, :-1] if axis else covered[:-1]
        b = covered[:, 1:] if axis else covered[1:]
        r, c = np.nonzero(a != b)
        r2, c2 = (r, c + 1) if axis else (r + 1, c)
        ins = a[r, c]
        pairs.append((np.where(ins, r, r2), np.where(ins, c, c2), np.where(ins, r2, r), np.where(ins, c2, c)))
        del a, b
    ri, ci, ro, co = (np.concatenate(v) for v in zip(*pairs))
    del pairs
    det_in, base_in, base_out = detail[ri, ci].copy(), base_on[ri, ci].copy(), base_on[ro, co].copy()

    # Distance from each covered pixel to the nearest uncovered one, with the
    # raster border counted as uncovered so the taper also reaches zero there.
    blend_px = args.blend_m / grid.pixel_m()
    mem = gdal.GetDriverByName('MEM')
    mask = mem.Create('', w + 2, h + 2, 1, gdal.GDT_Byte)
    mb = mask.GetRasterBand(1)
    mb.Fill(1)
    mb.WriteArray((~covered).view(np.uint8), 1, 1)
    prox = mem.Create('', w + 2, h + 2, 1, gdal.GDT_Float32)
    gdal.ComputeProximity(mb, prox.GetRasterBand(1),
                          ['VALUES=1', 'DISTUNITS=PIXEL', f'MAXDIST={math.ceil(blend_px) + 1}', 'NODATA=-1'])
    mask = mb = None
    # ponytail: distance in north-pixel units; east pixels are cos(lat) narrower (~5% at Jezero);
    # polar stereographic pixels are square, with scale ≤ 0.2% off true inside 85°.
    weight = prox.GetRasterBand(1).ReadAsArray(1, 1, w, h)
    prox = None
    for r0 in range(0, h, 1024):  # smoothstep in place: C1, zero slope at both ends
        t = weight[r0:r0 + 1024]
        np.clip(np.where(t < 0, blend_px, t) / blend_px, 0, 1, out=t)
        t *= t * (3 - 2 * t)
    weight[~covered] = 0
    print(f'taper: {args.blend_m:.0f} m band ({time.time() - t0:.0f}s)')

    for r0 in range(0, h, 1024):
        sl = slice(r0, r0 + 1024)
        d = detail[sl]
        d -= base_on[sl]
        if args.bias == 'plane':
            d -= (off + se * east_km[None, :] + sn * north_km[sl, None]).astype(np.float32)
        d *= weight[sl]
        d[~covered[sl]] = 0
    residual = detail
    del detail
    full = covered & (weight >= 1)
    band = covered & (weight < 1)
    hard = det_in - base_out
    fused_step = base_in + residual[ri, ci] - base_out
    boundary = {'hardSwitch': stats(hard), 'fused': stats(fused_step), 'base': stats(base_in - base_out)}
    report = {
        'generator': 'scripts/terrain/dem.py fuse',
        'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'base': raster_info(args.base),
        'detail': raster_info(args.detail),
        'grid': {'kind': grid.kind, 'geotransform': list(gt), 'size': [w, h],
                 'crs': base_ds.GetSpatialRef().ExportToProj4() if grid.kind == 'geo' else grid.proj4,
                 'geoBounds': list(grid.geo_bounds())},
        'baseScaleOffset': [bscale, boff],
        'verticalDatum': args.vertical_datum,
        'kernel': 'base: Catmull-Rom, pixel-is-area, longitude wraps' + (
            '; inside the detail coverage the base is the detail-grid resample (base.tif), blended by weight'
            if grid.kind == 'stere' else ''),
        'coverageFraction': float(covered.mean()),
        'registration': {
            'model': 'detail − base = offset + slopeEast·east + slopeNorth·north (least squares)',
            'axes': planar_axes,
            'centroid': {'lonDeg': lon0, 'latDeg': lat0},
            'fitStridePx': step,
            'offsetM': off, 'slopeEastMPerKm': se, 'slopeNorthMPerKm': sn,
            'tiltDeg': math.degrees(math.atan(math.hypot(se, sn) / 1000)),
            'raw': stats(diff_sub),
            'afterPlane': stats(diff_sub - plane_sub),
            'removed': args.bias == 'plane',
            'note': ('the fitted plane is subtracted before the residual is formed: the fused surface follows the base at broad scale'
                     if args.bias == 'plane' else
                     'the fitted plane is disclosed but kept: the detail keeps its absolute heights and the taper band carries the bias back to the base'),
        },
        'taper': {'blendM': args.blend_m, 'function': 'smoothstep(distance to coverage edge / blendM)',
                  'fullWeightFraction': float(full.mean()), 'bandFraction': float(band.mean())},
        'boundary': {'pairs': int(len(ri)),
                     'note': 'pixel pairs across the coverage edge; step = inside − outside (m)',
                     'hardSwitchStepM': boundary['hardSwitch'], 'fusedStepM': boundary['fused'],
                     'baseStepM': boundary['base']},
        'residual': {'all': stats(residual[::step, ::step][sub]),
                     'fullWeight': stats(residual[::step, ::step][full[::step, ::step]])},
        'products': {'residual': 'residual.tif', 'coverage': 'coverage.tif', 'weight': 'weight.tif', 'fused': 'fused.tif',
                     **({'base': 'base.tif'} if grid.kind == 'stere' else {})},
    }
    del full, band
    srs = base_ds.GetProjection() if grid.kind == 'geo' else grid.wkt
    if grid.kind == 'stere':
        write_tif(os.path.join(args.out, 'base.tif'), base_on, gt, srs)
    write_tif(os.path.join(args.out, 'residual.tif'), residual, gt, srs)
    write_tif(os.path.join(args.out, 'coverage.tif'), covered.view(np.uint8), gt, srs, dtype=gdal.GDT_Byte)
    write_tif(os.path.join(args.out, 'weight.tif'), weight, gt, srs)
    del weight
    for r0 in range(0, h, 1024):  # fused = base + residual, reusing base_on as the buffer
        base_on[r0:r0 + 1024] += residual[r0:r0 + 1024]
    write_tif(os.path.join(args.out, 'fused.tif'), base_on, gt, srs)
    with open(os.path.join(args.out, 'fusion.json'), 'w') as f:
        json.dump(report, f, indent=2)
    r = report['registration']
    print(f"registration raw: {fmt(r['raw'])}\n           plane: {fmt(r['afterPlane'])}")
    print(f"residual (full weight): {fmt(report['residual']['fullWeight'])}")
    print(f"boundary step, hard switch: {fmt(boundary['hardSwitch'])}\n"
          f"                     fused: {fmt(boundary['fused'])}\n"
          f"                      base: {fmt(boundary['base'])}")
    print(f'wrote {args.out} ({time.time() - t0:.0f}s)')


def fmt(s):
    return (f"n={s['n']} mean={s['meanM']:.2f} rms={s['rmsM']:.2f} "
            f"p95={s['p95AbsM']:.2f} max={s['maxAbsM']:.2f} m") if s['n'] else 'n=0'


# ---------------------------------------------------------------------------
# Right-triangulated irregular network (Martini-style) on a (2^k + 1)² grid.
# The hierarchy depends only on the grid size, so it is built once; per tile we
# only accumulate errors and walk it. Edge vertices are forced in, which keeps
# every shared edge at full grid resolution and identical on both sides.

GRID = 65  # vertices per tile side; tile edges carry all 65


def build_rtin(n=GRID):
    s = n - 1
    levels = []  # per level: arrays a, b, c, m (flat vertex index), child ids
    nodes = [((0, 0), (s, s), (s, 0)), ((s, s), (0, 0), (0, s))]
    while nodes:
        a = np.array([t[0] for t in nodes]); b = np.array([t[1] for t in nodes]); c = np.array([t[2] for t in nodes])
        split = np.abs(a - c).sum(1) > 1
        m = (a + b) // 2
        nxt, child = [], np.full((len(nodes), 2), -1)
        for i, (ta, tb, tc) in enumerate(nodes):
            if split[i]:
                tm = tuple(m[i])
                child[i] = (len(nxt), len(nxt) + 1)
                nxt += [(tc, ta, tm), (tb, tc, tm)]
        flat = lambda p: p[:, 1] * n + p[:, 0]
        levels.append({'a': flat(a), 'b': flat(b), 'c': flat(c), 'm': flat(m), 'split': split, 'child': child,
                       'hyp': float(np.hypot(*(a[0] - b[0])))})
        nodes = nxt
    # Each midpoint is shared by at most two triangles of one level; split them
    # into two duplicate-free groups so error maxima need no ufunc.at.
    for L in levels:
        idx = np.nonzero(L['split'])[0]
        _, first = np.unique(L['m'][idx], return_index=True)
        g1 = np.zeros(len(idx), bool); g1[first] = True
        L['g1'], L['g2'] = idx[g1], idx[~g1]
    edge = np.zeros(n * n, bool)
    ij = np.arange(n * n)
    edge[(ij % n == 0) | (ij % n == s) | (ij // n == 0) | (ij // n == s)] = True
    return levels, edge


RTIN, EDGE = build_rtin()


def rtin_errors(h, spacing_rad=0.0, radius=0.0):
    """Per-vertex error: the interpolation error a vertex removes, maxed with its
    descendants'. Edge vertices are infinite, i.e. always kept.

    Heights are above a curved datum, so a flat triangle also cuts below the
    surface by the chord sag of its span, R·(1 − cos(θ/2)); without it, flat
    low-zoom tiles collapse to a few huge triangles and the globe goes faceted."""
    err = np.where(EDGE, np.inf, 0.0)
    for li in range(len(RTIN) - 1, -1, -1):
        L = RTIN[li]
        if not L['split'].any():
            continue
        own = np.abs((h[L['a']] + h[L['b']]) * 0.5 - h[L['m']])
        own = own + radius * (1 - math.cos(L['hyp'] * spacing_rad / 2))
        if li + 1 < len(RTIN):
            Ln = RTIN[li + 1]
            ch = L['child']
            kids = np.where(ch >= 0, Ln['m'][np.maximum(ch, 0)], -1)
            ke = np.where(kids >= 0, err[np.maximum(kids, 0)], 0)
            ke = np.where(Ln['split'][np.maximum(ch, 0)] & (ch >= 0), ke, 0)
            own = np.maximum(own, ke.max(1))
        for g in (L['g1'], L['g2']):
            mm = L['m'][g]
            err[mm] = np.maximum(err[mm], own[g])
    return err


def rtin_triangles(err, max_error):
    """Leaf triangles (CCW seen from above: u east, v north) for a threshold."""
    out = []
    active = np.arange(len(RTIN[0]['a']))
    for li, L in enumerate(RTIN):
        if len(active) == 0:
            break
        go = L['split'][active] & (err[L['m'][active]] > max_error)
        leaf = active[~go]
        out.append(np.stack([L['a'][leaf], L['c'][leaf], L['b'][leaf]], 1))
        active = L['child'][active[go]].ravel()
    return np.concatenate(out)


# ---------------------------------------------------------------------------
# quantized-mesh-1.0 writer

def zigzag_delta(q):
    d = np.diff(q.astype(np.int32), prepend=0)
    return ((d << 1) ^ (d >> 31)).astype(np.uint16)


def ecef(lon_deg, lat_deg, h, a, c):
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    e2 = 1 - (c * c) / (a * a)
    n = a / np.sqrt(1 - e2 * np.sin(lat) ** 2)
    return np.stack([(n + h) * np.cos(lat) * np.cos(lon), (n + h) * np.cos(lat) * np.sin(lon),
                     (n * (1 - e2) + h) * np.sin(lat)], -1)


def oct_encode(n):
    """Unit vectors → quantized-mesh oct-encoded bytes (Cesium AttributeCompression)."""
    p = n[:, :2] / np.abs(n).sum(1, keepdims=True)
    sgn = np.where(p >= 0, 1.0, -1.0)
    neg = n[:, 2] < 0
    p[neg] = ((1 - np.abs(p[neg][:, ::-1])) * sgn[neg])
    return np.round((np.clip(p, -1, 1) * 0.5 + 0.5) * 255).astype(np.uint8)


def encode_tile(heights, bounds, max_error, ellipsoid, normals=None):
    """heights: (GRID*GRID,) row-major, row 0 = south; normals: (GRID*GRID, 3)
    body-fixed unit vectors or None. Returns raw QM bytes."""
    a, c = ellipsoid
    spacing_rad = math.radians((bounds[3] - bounds[1]) / (GRID - 1))
    tri = rtin_triangles(rtin_errors(heights, spacing_rad, a), max_error)
    # High-water-mark order: renumber vertices by first appearance.
    flat = tri.ravel()
    used, first = np.unique(flat, return_index=True)
    order = used[np.argsort(first)]
    remap = np.empty(GRID * GRID, np.int64); remap[order] = np.arange(len(order))
    idx = remap[flat]
    gx, gy = order % GRID, order // GRID
    u = np.round(gx * 32767 / (GRID - 1)).astype(np.int32)
    v = np.round(gy * 32767 / (GRID - 1)).astype(np.int32)
    hv = heights[order]
    lo, hi = np.float32(hv.min()), np.float32(hv.max())
    span = float(hi) - float(lo)
    q = np.zeros(len(hv), np.int32) if span == 0 else np.clip(np.round((hv - float(lo)) / span * 32767), 0, 32767).astype(np.int32)

    w, s, e, n = bounds
    center = ecef(np.array((w + e) / 2), np.array((s + n) / 2), (float(lo) + float(hi)) / 2, a, c)
    pos = ecef(w + gx / (GRID - 1) * (e - w), s + gy / (GRID - 1) * (n - s), hv, a, c)
    radius = float(np.sqrt(((pos - center) ** 2).sum(1)).max())
    # Horizon-occlusion point is left zero: 3d-tiles-renderer derives culling
    # from the layer's region bounds and never reads it.
    header = struct.pack('<3d2f4d3d', *center, lo, hi, *center, radius, 0, 0, 0)

    seen = np.maximum.accumulate(np.concatenate([[0], idx[:-1] + 1]))  # highest+1 before each
    hwm = seen - idx  # code = highest - index, 0 introduces a new vertex
    assert hwm.min() >= 0
    big = len(order) > 65536
    it = np.uint32 if big else np.uint16

    def edge(sel, key):
        e_ = np.nonzero(sel)[0]
        return e_[np.argsort(key[e_])]

    edges = [edge(u == 0, v), edge(v == 0, u), edge(u == 32767, v), edge(v == 32767, u)]
    parts = [header, struct.pack('<I', len(order)), zigzag_delta(u).tobytes(), zigzag_delta(v).tobytes(),
             zigzag_delta(q).tobytes()]
    if big and (88 + 4 + 6 * len(order)) % 4:
        parts.append(b'\0' * (4 - (88 + 4 + 6 * len(order)) % 4))
    parts += [struct.pack('<I', len(tri)), hwm.astype(it).tobytes()]
    for ed in edges:
        parts += [struct.pack('<I', len(ed)), ed.astype(it).tobytes()]
    if normals is not None:
        oct_ = oct_encode(normals[order]).tobytes()
        parts += [struct.pack('<BI', 1, len(oct_)), oct_]
    return b''.join(parts), len(order), len(tri)


# ---------------------------------------------------------------------------
# tile

def tile_bounds(z, x, y):
    dx, dy = 360 / 2 ** (z + 1), 180 / 2 ** z
    return (-180 + x * dx, -90 + y * dy, -180 + (x + 1) * dx, -90 + (y + 1) * dy)


def pick_level(levels, spacing_deg, unit_deg=1.0):
    """Coarsest pyramid level whose pixels are still no larger than the vertex
    spacing — enough detail without aliasing far finer data into a tile.
    `unit_deg` converts the levels' native pixel units to degrees."""
    best = 0
    for i, (_, gt) in enumerate(levels):
        if gt[1] * unit_deg <= spacing_deg * 1.0001:
            best = i
    return best


def box_pyramid(arr, gt, min_size=16):
    """2× box-averaged pyramid of a residual; zero outside stays zero."""
    out = [(arr, gt)]
    while min(arr.shape) >= 2 * min_size:
        h, w = arr.shape[0] // 2 * 2, arr.shape[1] // 2 * 2
        a = arr[:h, :w].reshape(h // 2, 2, w // 2, 2).mean((1, 3), dtype=np.float64).astype(np.float32)
        gt = (gt[0], gt[1] * 2, 0, gt[3], 0, gt[5] * 2)
        out.append((a, gt))
        arr = a
    return out


_T = {}  # tiling state inherited by forked workers


def field_heights(lon, lat, spacing_deg):
    """The fused height field (m) at lon/lat, sampled at the source levels a
    vertex spacing calls for. Every tiler writes from this one function, so the
    geographic and polar pyramids describe the same surface."""
    S = _T
    bl = S['base'][pick_level(S['base'], spacing_deg)]
    grid = S['grid']
    rlev = pick_level(S['residual'], spacing_deg, grid.unit_deg)
    rl = S['residual'][rlev]
    rb = S['residual_bounds']
    bscale, boff = S['base_scale_offset']
    hgt = cubic(bl[0], bl[1], lon, lat, wrap_lon=True).astype(np.float64) * bscale + boff
    if lon.min() < rb[2] and lon.max() > rb[0] and lat.min() < rb[3] and lat.max() > rb[1]:
        gxy = grid.project(lon, lat)
        res = bilinear(rl[0], rl[1], *gxy, outside=0.0)
        if grid.kind == 'stere':
            # Pole-safe: inside coverage, hand the base over to its detail-grid resample.
            wt = bilinear(S['weight'][rlev][0], rl[1], *gxy, outside=0.0)
            hgt = (1 - wt) * hgt + wt * bilinear(S['base_xy'][rlev][0], rl[1], *gxy, outside=0.0)
        hgt = hgt + res
    return hgt


def ring_normals(P, lon, lat):
    """Unit normals at the interior of a (G+2)² vertex lattice whose axis 1
    runs east-ish and axis 0 north-ish: central differences over the one-vertex
    ring outside a tile, so both sides of a shared edge use the same neighbours
    and shading has no tile seams."""
    nrm = np.cross(P[1:-1, 2:] - P[1:-1, :-2], P[2:, 1:-1] - P[:-2, 1:-1]).reshape(-1, 3)
    ln = np.linalg.norm(nrm, axis=1, keepdims=True)
    la, lo = np.radians(lat[1:-1, 1:-1]).ravel(), np.radians(lon[1:-1, 1:-1]).ravel()
    up = np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], 1)
    return np.where(ln > 1e-9, nrm / np.maximum(ln, 1e-12), up)  # poles: degenerate lattice


def tile_job(job):
    z, x0, x1, y = job
    S = _T
    w, s, e, n = tile_bounds(z, x0, y)
    spacing = (n - s) / (GRID - 1)
    # One extra vertex ring outside the tile, for ring_normals.
    frac = np.arange(-1, GRID + 1) / (GRID - 1)
    a, c = S['ellipsoid']
    max_err = S['error_frac'] * spacing * math.pi / 180 * S['ellipsoid'][0]
    written = verts = 0
    for x in range(x0, x1):
        w, s, e, n = tile_bounds(z, x, y)
        G = GRID + 2
        lon = np.broadcast_to(w + frac * (e - w), (G, G))
        lat = np.broadcast_to(np.clip(s + frac * (n - s), -90, 90)[:, None], (G, G))
        hgt = field_heights(lon, lat, spacing)
        nrm = ring_normals(ecef(lon, lat, hgt, a, c), lon, lat)
        data, nv, _ = encode_tile(hgt[1:-1, 1:-1].ravel(), (w, s, e, n), max_err, S['ellipsoid'], nrm)
        d = os.path.join(S['out'], str(z), str(x))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{y}.terrain'), 'wb') as f:
            f.write(gzip.compress(data, 6, mtime=0))
        written += 1; verts += nv
    return written, verts


def load_field(base_path, fusion_dir, spacings_deg):
    """Load what `field_heights` samples into `_T`: the base raster and its
    overviews, and the fusion rasters' box pyramids. Only the levels some
    spacing in `spacings_deg` picks are read into memory."""
    base, base_gt, _, base_so = open_base(base_path)
    ds = gdal.Open(base_path)
    b = ds.GetRasterBand(1)
    levels = [(base, base_gt)]
    W, H = ds.RasterXSize, ds.RasterYSize
    for i in range(b.GetOverviewCount()):
        o = b.GetOverview(i)
        levels.append((None, (base_gt[0], base_gt[1] * W / o.XSize, 0, base_gt[3], 0, base_gt[5] * H / o.YSize)))
    for li in sorted({pick_level(levels, sp) for sp in spacings_deg} - {0}):
        levels[li] = (b.GetOverview(li - 1).ReadAsArray(), levels[li][1])  # native dtype: half the RAM of float32
        print(f'  base overview {li}: {levels[li][0].shape[1]}×{levels[li][0].shape[0]}')

    grid = Grid(gdal.Open(os.path.join(fusion_dir, 'residual.tif')))

    def pyramid(name):
        ds_ = gdal.Open(os.path.join(fusion_dir, name))
        p = box_pyramid(ds_.GetRasterBand(1).ReadAsArray(), grid.gt)
        ds_ = None
        keep = {pick_level(p, sp, grid.unit_deg) for sp in spacings_deg}
        return [lv if i in keep else (None, lv[1]) for i, lv in enumerate(p)]

    _T.update(base=levels, base_scale_offset=base_so, grid=grid, residual=pyramid('residual.tif'),
              residual_bounds=grid.geo_bounds())
    if grid.kind == 'stere':
        _T.update(weight=pyramid('weight.tif'), base_xy=pyramid('base.tif'))
    return grid


def cmd_tile(args):
    t0 = time.time()
    fusion = json.load(open(os.path.join(args.fusion, 'fusion.json')))
    grid = load_field(args.base, args.fusion, [180 / 2 ** z / (GRID - 1) for z in range(args.max_zoom + 1)])
    rbounds = _T['residual_bounds']
    _T.update(out=args.out, error_frac=args.error_frac, ellipsoid=tuple(args.ellipsoid))
    print(f'loaded sources ({time.time() - t0:.0f}s)')

    # Regional levels cover the residual plus any extra area (e.g. where
    # high-resolution imagery is draped: imagery detail follows terrain depth).
    tb = rbounds
    if args.regional_bounds:
        rg = args.regional_bounds
        tb = (min(tb[0], rg[0]), min(tb[1], rg[1]), max(tb[2], rg[2]), max(tb[3], rg[3]))
    available, jobs = [], []
    chunk = 64
    for z in range(args.max_zoom + 1):
        nx, ny = 2 ** (z + 1), 2 ** z
        if z <= args.global_zoom:
            xr, yr = (0, nx - 1), (0, ny - 1)
        else:
            zb = (args.zoom_bounds or {}).get(z, tb)
            dx, dy = 360 / nx, 180 / ny
            xr = (int((zb[0] + 180) // dx), int(math.ceil((zb[2] + 180) / dx)) - 1)
            yr = (int((zb[1] + 90) // dy), int(math.ceil((zb[3] + 90) / dy)) - 1)
        available.append([{'startX': xr[0], 'startY': yr[0], 'endX': xr[1], 'endY': yr[1]}])
        for y in range(yr[0], yr[1] + 1):
            for x0 in range(xr[0], xr[1] + 1, chunk):
                jobs.append((z, x0, min(x0 + chunk, xr[1] + 1), y))
    if args.only_zoom is not None:
        jobs = [j for j in jobs if j[0] in args.only_zoom]
    total = sum(j[2] - j[1] for j in jobs)
    print(f'{total:,} tiles in {len(jobs):,} jobs on {args.workers} workers')

    done = verts = 0
    with mp.get_context('fork').Pool(args.workers) as pool:
        for k, (n, nv) in enumerate(pool.imap_unordered(tile_job, jobs, chunksize=4)):
            done += n; verts += nv
            if k % 500 == 0:
                el = time.time() - t0
                print(f'  {done:,}/{total:,} tiles, {verts / max(done, 1):.0f} verts/tile ({el:.0f}s)', flush=True)

    reg = fusion['registration']
    layer = {
        'tilejson': '2.1.0',
        'name': args.name,
        'description': (f"Fused terrain: canonical {os.path.basename(fusion['base']['path'])} plus tapered "
                        f"{os.path.basename(fusion['detail']['path'])} residual. See terrain-product.json."),
        'version': '1.0.0',
        'format': 'quantized-mesh-1.0',
        'attribution': args.attribution,
        'schema': 'tms',
        'tiles': ['{z}/{x}/{y}.terrain'],
        'projection': 'EPSG:4326',
        'bounds': [-180, -90, 180, 90],
        'extensions': ['octvertexnormals'],
        'available': available,
        'minzoom': 0,
        'maxzoom': args.max_zoom,
    }
    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'layer.json'), 'w') as f:
        json.dump(layer, f, indent=1)
    product = {
        'generator': 'scripts/terrain/dem.py tile',
        'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'heightField': 'base(lon,lat) [Catmull-Rom] + residual(lon,lat) [bilinear], one field for every level',
        'normals': 'octvertexnormals from central differences of the same field (one-vertex ring past each tile)',
        'verticalDatum': fusion['verticalDatum'],
        'tileCenterEllipsoidM': args.ellipsoid,
        'mesh': {'grid': GRID, 'simplification': 'RTIN, all edge vertices kept',
                 'maxErrorFractionOfSpacing': args.error_frac},
        'levels': {'global': [0, args.global_zoom], 'regional': [args.global_zoom + 1, args.max_zoom],
                   'regionalBounds': list(tb), 'residualBounds': list(rbounds),
                   **({'zoomBounds': {str(k): v for k, v in args.zoom_bounds.items()}} if args.zoom_bounds else {})},
        'residualGrid': {'kind': grid.kind, 'crs': grid.proj4},
        'sources': {'canonical': fusion['base'], 'detail': fusion['detail']},
        'registration': {k: reg[k] for k in ('model', 'centroid', 'offsetM', 'slopeEastMPerKm',
                                              'slopeNorthMPerKm', 'tiltDeg', 'raw', 'afterPlane', 'removed', 'note')},
        'taper': fusion['taper'],
        'residual': fusion['residual'],
        'tileCount': total,
    }
    with open(os.path.join(args.out, 'terrain-product.json'), 'w') as f:
        json.dump(product, f, indent=2)
    print(f'wrote {total:,} tiles to {args.out} ({time.time() - t0:.0f}s)')


# ---------------------------------------------------------------------------
# polar-tile (issue #144): square tiles on the detail's polar stereographic grid
#
# Geographic tiles at a pole are slivers — at z12 a polar tile is ~12 m × 1.3 km
# and one ground-level view needs thousands of them, too many for the imagery
# overlay's per-tile texture. Here the cap is a quadtree on the polar
# stereographic plane instead, so tiles stay square at every level. It samples
# the same `field_heights`, and is written as 3D Tiles 1.1 with one .glb per
# tile: a full GRID² lattice (no simplification, so no long thin triangles),
# normals from `ring_normals`, and skirts that copy their edge's normals so they
# shade like the surface instead of catching low sun as walls.

def encode_glb(pos, nrm, idx, translation):
    """One-mesh glTF 2.0 binary. Inputs are in the tileset's Z-up body-fixed
    frame (positions relative to `translation`); glTF is Y-up, so axes are
    rotated here and the renderer rotates them back."""
    yup = lambda v: np.asarray(v, np.float64)[..., [0, 2, 1]] * np.array([1.0, 1.0, -1.0])
    pos32 = yup(pos).astype(np.float32)
    nrm32 = yup(nrm).astype(np.float32)
    big = len(pos) > 65535
    ind = idx.astype(np.uint32 if big else np.uint16).ravel()
    pb, nb, ib = pos32.tobytes(), nrm32.tobytes(), ind.tobytes()
    ib += b'\0' * (-len(ib) % 4)
    gltf = {
        'asset': {'version': '2.0', 'generator': 'scripts/terrain/dem.py polar-tile'},
        'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'translation': [float(v) for v in yup(translation)]}],
        'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1}, 'indices': 2, 'material': 0}]}],
        'materials': [{'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 1], 'metallicFactor': 0, 'roughnessFactor': 1}}],
        'buffers': [{'byteLength': len(pb) + len(nb) + len(ib)}],
        'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': len(pb), 'target': 34962},
                        {'buffer': 0, 'byteOffset': len(pb), 'byteLength': len(nb), 'target': 34962},
                        {'buffer': 0, 'byteOffset': len(pb) + len(nb), 'byteLength': len(ind) * ind.itemsize, 'target': 34963}],
        'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': len(pos32), 'type': 'VEC3',
                       'min': pos32.min(0).tolist(), 'max': pos32.max(0).tolist()},
                      {'bufferView': 1, 'componentType': 5126, 'count': len(nrm32), 'type': 'VEC3'},
                      {'bufferView': 2, 'componentType': 5125 if big else 5123, 'count': len(ind), 'type': 'SCALAR'}],
    }
    js = json.dumps(gltf, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    bin_ = pb + nb + ib
    return b''.join([struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(js) + 8 + len(bin_)),
                     struct.pack('<II', len(js), 0x4E4F534A), js, struct.pack('<II', len(bin_), 0x004E4942), bin_])


def lattice_indices(n=GRID):
    """Triangles of an n² lattice (row = y, column = x), CCW seen from above,
    plus the CCW boundary loop the skirts hang from."""
    i, j = np.meshgrid(np.arange(n - 1), np.arange(n - 1))
    v00 = (j * n + i).ravel()
    tri = np.concatenate([np.stack([v00, v00 + 1, v00 + n + 1], 1), np.stack([v00, v00 + n + 1, v00 + n], 1)])
    k = np.arange(n)
    loops = [k, k * n + n - 1, (n - 1) * n + k[::-1], k[::-1] * n]  # S, E, N, W edges, interior on the left
    return tri, loops


LATTICE_TRI, LATTICE_EDGES = lattice_indices()


def with_skirts(P, nrm, depth):
    """Append a skirt below each lattice edge: copies of the edge vertices
    moved `depth` m toward the body centre, keeping the edge normals."""
    pos, nor, tri = [P], [nrm], [LATTICE_TRI]
    nv = len(P)
    for loop in LATTICE_EDGES:
        down = P[loop] - P[loop] / np.linalg.norm(P[loop], axis=1, keepdims=True) * depth
        b = nv + np.arange(len(loop))
        t = loop
        tri.append(np.concatenate([np.stack([t[:-1], b[:-1], t[1:]], 1), np.stack([t[1:], b[:-1], b[1:]], 1)]))
        pos.append(down); nor.append(nrm[loop])
        nv += len(loop)
    return np.concatenate(pos), np.concatenate(nor), np.concatenate(tri)


def polar_tile_square(L, ix, iy):
    """(x0, y0, size) in projection metres: tile (ix, iy) of level L, row 0 at −y."""
    H = _T['half_extent']
    size = 2 * H / 2 ** L
    return -H + ix * size, -H + iy * size, size


def polar_tile_wanted(L, ix, iy):
    """Level L may be narrowed to a disc around the pole (`--level-radius`)."""
    r = _T['level_radius'].get(L)
    if r is None:
        return True
    x0, y0, size = polar_tile_square(L, ix, iy)
    return math.hypot(max(0.0, x0, -(x0 + size)), max(0.0, y0, -(y0 + size))) < r


def polar_tile_job(job):
    S = _T
    a, c = S['ellipsoid']
    grid = S['grid']
    out = []
    for L, ix, iy in job:
        x0, y0, size = polar_tile_square(L, ix, iy)
        cell = size / (GRID - 1)
        k = np.arange(-1, GRID + 1) * cell
        X, Y = np.meshgrid(x0 + k, y0 + k)  # axis 0 = y (north-ish), axis 1 = x (east-ish)
        lon, lat = grid.unproject(X, Y)
        hgt = field_heights(lon, lat, cell * grid.unit_deg)
        P = ecef(lon, lat, hgt, a, c)
        nrm = ring_normals(P, lon, lat)
        surf = P[1:-1, 1:-1].reshape(-1, 3)
        pos, nor, tri = with_skirts(surf, nrm, S['skirt_cells'] * cell)
        lo, hi = pos.min(0), pos.max(0)
        center = (lo + hi) / 2
        d = os.path.join(S['out'], str(L), str(ix))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{iy}.glb'), 'wb') as f:
            f.write(encode_glb(pos - center, nor, tri, center))
        half = (hi - lo) / 2
        out.append((L, ix, iy, [*center.tolist(), half[0], 0, 0, 0, half[1], 0, 0, 0, half[2]],
                    float(hgt.min()), float(hgt.max())))
    return out


def cmd_polar_tile(args):
    t0 = time.time()
    fusion = json.load(open(os.path.join(args.fusion, 'fusion.json')))
    rds = gdal.Open(os.path.join(args.fusion, 'residual.tif'))
    gt, w, h = rds.GetGeoTransform(), rds.RasterXSize, rds.RasterYSize
    H = gt[1] * w / 2
    if Grid(rds).kind != 'stere' or abs(gt[0] + H) > 1e-6 or abs(gt[3] - H) > 1e-6 or w != h:
        raise SystemExit('polar-tile needs a square polar stereographic detail grid centred on its pole')
    rds = None
    cells = [2 * H / 2 ** L / (GRID - 1) for L in range(args.max_level + 1)]
    grid = load_field(args.base, args.fusion, [cl * 180 / (math.pi * args.ellipsoid[0]) for cl in cells])
    _T.update(out=args.out, ellipsoid=tuple(args.ellipsoid), half_extent=H, skirt_cells=args.skirt_cells,
              level_radius=args.level_radius or {})
    print(f'loaded sources ({time.time() - t0:.0f}s)')

    # REPLACE refinement swaps a parent for all of its children, so a parent
    # refines into a complete set of four or not at all: it refines when any
    # child is wanted (`--level-radius`), and its unwanted siblings are written
    # as leaves. Only wanted tiles refine further.
    # Level 0 is the whole square, which straddles the antimeridian (the −y
    # half-axis). The imagery overlay derives UVs from each vertex's longitude,
    # so triangles crossing ±180° would interpolate across the whole texture.
    # The root therefore carries no content: rendering starts at the four
    # level-1 quadrants, whose shared edges lie on the antimeridian and on lon 0/±90.
    keys, refining = [], [(0, 0)]
    for L in range(1, args.max_level + 1):
        nxt = []
        for px, py in refining:
            kids = [(2 * px + dx, 2 * py + dy) for dy in (0, 1) for dx in (0, 1)]
            if any(polar_tile_wanted(L, x, y) for x, y in kids):
                keys += [(L, x, y) for x, y in kids]
                nxt += [(x, y) for x, y in kids if polar_tile_wanted(L, x, y)]
        refining = nxt
    jobs = [keys[i:i + 16] for i in range(0, len(keys), 16)]
    print(f'{len(keys):,} tiles in {len(jobs):,} jobs on {args.workers} workers')
    tiles = {}
    with mp.get_context('fork').Pool(args.workers) as pool:
        for k, rows in enumerate(pool.imap_unordered(polar_tile_job, jobs)):
            for L, ix, iy, box, hmin, hmax in rows:
                tiles[(L, ix, iy)] = (box, hmin, hmax)
            if k % 200 == 0:
                print(f'  {len(tiles):,}/{len(keys):,} tiles ({time.time() - t0:.0f}s)', flush=True)

    # Geometric error tracks vertex spacing the way quantized-mesh levels do
    # (3d-tiles-renderer: ≈ 0.246 × latitudinal spacing), so one errorTarget
    # refines both pyramids to comparable on-screen detail.
    # A tile's bounding volume must hold its whole subtree: finer levels resolve
    # relief the coarse mesh smooths away, and the renderer culls a subtree by
    # its root's volume. The content keeps its own tight box.
    def union(a, b):
        lo = np.minimum(np.array(a[:3]) - [a[3], a[7], a[11]], np.array(b[:3]) - [b[3], b[7], b[11]])
        hi = np.maximum(np.array(a[:3]) + [a[3], a[7], a[11]], np.array(b[:3]) + [b[3], b[7], b[11]])
        c, h = (lo + hi) / 2, (hi - lo) / 2
        return [*c.tolist(), h[0], 0, 0, 0, h[1], 0, 0, 0, h[2]]

    def node(L, ix, iy):
        kids = [node(L + 1, 2 * ix + dx, 2 * iy + dy) for dy in (0, 1) for dx in (0, 1)
                if (L + 1, 2 * ix + dx, 2 * iy + dy) in tiles]
        own = tiles[(L, ix, iy)][0] if L else kids[0]['boundingVolume']['box']
        box = own
        for k in kids:
            box = union(box, k['boundingVolume']['box'])
        n = {'boundingVolume': {'box': box}, 'geometricError': 0.25 * cells[L] if kids else 0}
        if L:
            n['content'] = {'uri': f'{L}/{ix}/{iy}.glb', 'boundingVolume': {'box': own}}
        if kids:
            n['children'] = kids
        return n

    root = node(0, 0, 0)
    root['refine'] = 'REPLACE'
    # The content-less root must always refine, or a distant view draws nothing.
    root['geometricError'] = 1e9
    tileset = {'asset': {'version': '1.1', 'generator': 'scripts/terrain/dem.py polar-tile'},
               'geometricError': 2 * root['geometricError'], 'root': root}
    with open(os.path.join(args.out, 'tileset.json'), 'w') as f:
        json.dump(tileset, f, separators=(',', ':'))
    per_level = {}
    for (L, _, _) in tiles:
        per_level[L] = per_level.get(L, 0) + 1
    product = {
        'generator': 'scripts/terrain/dem.py polar-tile',
        'created': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'heightField': 'dem.py field_heights — the same fused field the quantized-mesh pyramid samples',
        'tiling': {'crs': grid.proj4, 'halfExtentM': H, 'levels': args.max_level + 1,
                   'levelRadiusM': {str(k): v for k, v in (args.level_radius or {}).items()},
                   'vertexSpacingM': cells, 'tilesPerLevel': per_level},
        'mesh': {'grid': GRID, 'simplification': 'none (full lattice)', 'skirtDepth': f'{args.skirt_cells} × vertex spacing',
                 'normals': 'central differences of the field over a one-vertex ring past each tile; skirts copy edge normals'},
        'verticalDatum': fusion['verticalDatum'],
        'ellipsoidM': args.ellipsoid,
        'tileCount': len(tiles),
    }
    with open(os.path.join(args.out, 'terrain-product.json'), 'w') as f:
        json.dump(product, f, indent=2)
    print(f'wrote {len(tiles):,} tiles to {args.out} ({time.time() - t0:.0f}s)')


# ---------------------------------------------------------------------------

def cmd_selftest(_):
    rng = np.random.default_rng(1)
    gx, gy = np.meshgrid(np.arange(GRID), np.arange(GRID))
    h = (np.sin(gx / 7.0) * 30 + gy * 0.5 + rng.normal(0, 0.2, gx.shape)).ravel()
    tri = rtin_triangles(rtin_errors(h), 1.0)
    p = np.stack([tri % GRID, tri // GRID], -1).astype(np.float64)
    cross = ((p[:, 1, 0] - p[:, 0, 0]) * (p[:, 2, 1] - p[:, 0, 1])
             - (p[:, 1, 1] - p[:, 0, 1]) * (p[:, 2, 0] - p[:, 0, 0]))
    assert (cross > 0).all(), 'triangles must be CCW'
    assert abs(cross.sum() / 2 - (GRID - 1) ** 2) < 1e-9, 'triangles must tile the square exactly'
    assert set(np.nonzero(EDGE)[0]) <= set(tri.ravel()), 'every edge vertex must be kept'
    assert len(np.unique(tri)) < GRID * GRID, 'simplification must drop interior vertices'
    full = rtin_triangles(rtin_errors(h), -1)
    assert len(full) == 2 * (GRID - 1) ** 2
    data, nv, nt = encode_tile(h, (77, 18, 77.01, 18.01), 1.0, (3396190.0, 3376200.0))
    assert struct.unpack_from('<I', data, 88)[0] == nv and nt == len(tri)
    # bilinear reproduces pixel centres and wraps longitude
    arr = np.arange(12, dtype=np.float64).reshape(3, 4)
    gt = (-180, 90, 0, 90, 0, -60)
    assert bilinear(arr, gt, np.array([-135.0]), np.array([60.0]))[0] == 0
    assert bilinear(arr, gt, np.array([180.0]), np.array([60.0]), wrap_lon=True)[0] == 1.5
    # Catmull-Rom reproduces pixel centres; chord sag forces flat wide tiles to split
    assert abs(cubic(arr, gt, np.array([-45.0]), np.array([0.0]))[0] - 5) < 1e-12
    flat_ = np.zeros(GRID * GRID)
    assert len(rtin_triangles(rtin_errors(flat_), 1.0)) < len(rtin_triangles(rtin_errors(flat_, math.radians(2.8), 3396190.0), 1.0))
    n = np.array([[0, 0, 1.0], [0, 0, -1.0], [1.0, 0, 0], [0.6, -0.8, 0]])
    assert oct_encode(n).shape == (4, 2)
    selftest_polar()
    print(f'selftest ok: {nv} vertices, {nt} triangles from {GRID * GRID}')


def selftest_polar():
    """Polar stereographic detail over a scaled Int16 eqc base, end to end:
    projection vs. OSR, fuse, and tiles at the pole."""
    import shutil, tempfile
    tmp = tempfile.mkdtemp(prefix='dem-selftest-')
    try:
        _selftest_polar(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _selftest_polar(tmp):
    from osgeo import osr
    R = 1737400.0
    drv = gdal.GetDriverByName('GTiff')
    # Base: 0.5°/px eqc lat_ts=0 Int16 half-metres, a tilted plane plus waves.
    bw, bh, px = 720, 360, math.pi / 180 * R * 0.5
    lon = -180 + (np.arange(bw) + 0.5) * 0.5
    lat = 90 - (np.arange(bh) + 0.5) * 0.5
    L, P = np.meshgrid(np.radians(lon), np.radians(lat))
    X, Y, Z = np.cos(P) * np.cos(L), np.cos(P) * np.sin(L), np.sin(P)
    base_m = 800 * X + 300 * Y + 50 * Z + 40 * np.sin(9 * L) * np.cos(P)  # smooth on the sphere
    ds = drv.Create(os.path.join(tmp, 'base.tif'), bw, bh, 1, gdal.GDT_Int16)
    ds.SetGeoTransform((-180 * math.pi / 180 * R, px, 0, 90 * math.pi / 180 * R, 0, -px))
    ds.SetProjection(f'+proj=eqc +lat_ts=0 +lat_0=0 +lon_0=0 +x_0=0 +y_0=0 +R={R} +units=m +no_defs')
    b = ds.GetRasterBand(1)
    b.SetScale(0.5); b.SetOffset(0.0); b.SetNoDataValue(-32768)
    b.WriteArray(np.round(base_m / 0.5).astype(np.int16)); ds = None
    # Detail: 2 km px polar stereographic, 300 km square at the south pole.
    n, dpx = 150, 2000.0
    srs = osr.SpatialReference(); srs.ImportFromProj4(f'+proj=stere +lat_0=-90 +lon_0=0 +k=1 +x_0=0 +y_0=0 +R={R} +units=m +no_defs')
    ds = drv.Create(os.path.join(tmp, 'detail.tif'), n, n, 1, gdal.GDT_Float32)
    ds.SetGeoTransform((-n / 2 * dpx, dpx, 0, n / 2 * dpx, 0, -dpx)); ds.SetProjection(srs.ExportToWkt())
    ds = None
    g = Grid(gdal.Open(os.path.join(tmp, 'detail.tif')))
    geo = srs.CloneGeogCS()
    for s_ in (srs, geo):
        s_.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    ct = osr.CoordinateTransformation(geo, srs)
    for lo, la in ((0, -89.9), (129.8, -89.67), (-45, -87), (179, -86.5)):
        x, y = g.project(np.array(lo), np.array(la))
        ox, oy, _ = ct.TransformPoint(lo, la)
        assert abs(x - ox) < 1e-6 and abs(y - oy) < 1e-6, ((x, y), (ox, oy))
        ulo, ula = g.unproject(x, y)
        assert abs(ula - la) < 1e-9 and abs((ulo - lo + 180) % 360 - 180) < 1e-9
    # Detail heights: base + a crater-ish bump + 25 m bias; NaN corners exercise coverage.
    gx = g.gt[0] + (np.arange(n) + 0.5) * dpx
    gy = g.gt[3] + (np.arange(n) + 0.5) * -dpx
    XX, YY = np.meshgrid(gx, gy)
    dlon, dlat = g.unproject(XX, YY)
    Lr, Pr = np.radians(dlon), np.radians(dlat)
    det = (800 * np.cos(Pr) * np.cos(Lr) + 300 * np.cos(Pr) * np.sin(Lr) + 50 * np.sin(Pr)
           + 40 * np.sin(9 * Lr) * np.cos(Pr) + 25 - 400 * np.exp(-((XX - 20000) ** 2 + YY ** 2) / 30000 ** 2)
           + 300 * np.exp(-((XX + 40000) ** 2 + (YY - 30000) ** 2) / 2500 ** 2))  # narrow peak: only fine levels resolve it
    det[np.hypot(XX, YY) > 140000] = np.nan
    ds = gdal.Open(os.path.join(tmp, 'detail.tif'), gdal.GA_Update)
    ds.GetRasterBand(1).SetNoDataValue(float('nan')); ds.GetRasterBand(1).WriteArray(det.astype(np.float32)); ds = None
    fused = os.path.join(tmp, 'fused')
    cmd_fuse(argparse.Namespace(base=os.path.join(tmp, 'base.tif'), detail=os.path.join(tmp, 'detail.tif'), out=fused,
                                blend_m=20000, fit_stride=1, bias='none', vertical_datum='test'))
    rep = json.load(open(os.path.join(fused, 'fusion.json')))
    assert abs(rep['registration']['offsetM'] - 25) < 30 and rep['grid']['kind'] == 'stere'
    out = os.path.join(tmp, 'tiles')
    cmd_tile(argparse.Namespace(base=os.path.join(tmp, 'base.tif'), fusion=fused, out=out, global_zoom=2, max_zoom=4,
                                regional_bounds=None, only_zoom=None, zoom_bounds={4: [-180, -90, 180, -88]},
                                error_frac=0.1, ellipsoid=[R, R], workers=1, name='t', attribution=''))

    def heights(z, x, y):
        raw = gzip.decompress(open(os.path.join(out, str(z), str(x), f'{y}.terrain'), 'rb').read())
        lo_, hi_ = struct.unpack_from('<2f', raw, 24)
        nv = struct.unpack_from('<I', raw, 88)[0]
        dec = lambda k: np.cumsum(((lambda v: (v >> 1) ^ -(v & 1))(np.frombuffer(raw, '<u2', nv, 92 + 2 * k * nv).astype(np.int32))))
        u, v, q = dec(0), dec(1), dec(2)
        return u, v, lo_ + q / 32767 * (hi_ - lo_), (hi_ - lo_) / 32767

    # Every tile touching the south pole reports the same pole height (quantization aside).
    for z in (3, 4):
        pole, tol = [], 0.0
        for x in range(2 ** (z + 1)):
            u, v, h_, qs = heights(z, x, 0)
            pole += list(h_[v == 0])
            tol = max(tol, qs)
        assert np.ptp(pole) <= 2.5 * tol, (z, np.ptp(pole), tol)
        # …and it is the fused detail there (weight 1 at the pole), at the pyramid level the tile samples.
        fds = gdal.Open(os.path.join(fused, 'fused.tif'))
        fp = box_pyramid(fds.GetRasterBand(1).ReadAsArray(), g.gt)
        lvl = fp[pick_level(fp, 180 / 2 ** z / (GRID - 1), g.unit_deg)]
        want = float(bilinear(lvl[0].astype(np.float64), lvl[1], np.array(0.0), np.array(0.0)))
        assert abs(np.mean(pole) - want) < 3 * tol + 1e-3, (z, np.mean(pole), want, tol)
    # Shared same-LOD edges carry identical heights.
    for z, x in ((4, 5), (3, 7)):
        ua, va, ha, qa = heights(z, x, 0)
        ub, vb, hb, qb = heights(z, x + 1, 0)
        ea = dict(zip(va[ua == 32767], ha[ua == 32767]))
        eb = dict(zip(vb[ub == 0], hb[ub == 0]))
        assert ea.keys() == eb.keys() and max(abs(ea[k] - eb[k]) for k in ea) <= 1.5 * (qa + qb)

    # polar-tile: square glb tiles of the same field. Level 3 is pruned to a
    # disc, so only the four pole-touching level-2 tiles refine.
    cap = os.path.join(tmp, 'cap')
    cmd_polar_tile(argparse.Namespace(base=os.path.join(tmp, 'base.tif'), fusion=fused, out=cap, max_level=3,
                                      level_radius={3: 40000.0}, skirt_cells=1.0, ellipsoid=[R, R], workers=1))

    def glb(L, ix, iy):
        raw = open(os.path.join(cap, str(L), str(ix), f'{iy}.glb'), 'rb').read()
        jl = struct.unpack_from('<I', raw, 12)[0]
        js, b0 = json.loads(raw[20:20 + jl]), 20 + jl + 8
        acc, bv = js['accessors'], js['bufferViews']
        f32 = lambda a: np.frombuffer(raw, '<f4', acc[a]['count'] * 3, b0 + bv[a]['byteOffset']).reshape(-1, 3)
        back = lambda v: v[:, [0, 2, 1]] * np.array([1.0, -1.0, 1.0])  # glTF Y-up -> body-fixed Z-up
        t = np.array(js['nodes'][0]['translation'])
        return back(f32(0) + t)[:GRID * GRID].reshape(GRID, GRID, 3), back(f32(1).astype(np.float64))[:GRID * GRID]

    def inside(P_, box, tol=0.05):
        c_, h_ = np.array(box[:3]), np.array([box[3], box[7], box[11]])
        return bool((np.abs(P_.reshape(-1, 3) - c_) <= h_ + tol).all())

    # Every refining tile is replaced by all four children (REPLACE leaves no
    # holes), and every tile's surface lies inside its own and every ancestor's
    # bounding volume, including the narrow peak only the finer levels resolve.
    levels = {}

    def walk(n, ancestors):
        kids = n.get('children', [])
        if not ancestors:  # the root straddles the antimeridian, so it has no content and always refines
            assert 'content' not in n and len(kids) == 4 and n['geometricError'] >= 1e9
            for k in kids:
                walk(k, [n['boundingVolume']['box']])
            return
        L, ix, iy = (int(v) for v in n['content']['uri'][:-4].split('/'))
        levels[L] = levels.get(L, 0) + 1
        assert len(kids) in (0, 4), (n['content']['uri'], len(kids))
        P_, _ = glb(L, ix, iy)
        for box in [n['content']['boundingVolume']['box'], n['boundingVolume']['box'], *ancestors]:
            assert inside(P_, box), (n['content']['uri'], 'escapes a bounding volume')
        for k in kids:
            walk(k, ancestors + [n['boundingVolume']['box']])

    walk(json.load(open(os.path.join(cap, 'tileset.json')))['root'], [])
    assert levels == {1: 4, 2: 16, 3: 16}, levels
    q = {(ix, iy): glb(1, ix, iy) for ix in (0, 1) for iy in (0, 1)}
    for P_, n_ in q.values():
        up_ = P_.reshape(-1, 3) / np.linalg.norm(P_.reshape(-1, 3), axis=1, keepdims=True)
        assert ((n_ * up_).sum(1) > 0.9).all(), 'normals must point outward'
    # Shared edges coincide (float32 offsets from the tile centre aside), and the pole is one vertex.
    assert np.abs(q[(0, 0)][0][:, -1] - q[(1, 0)][0][:, 0]).max() < 0.05
    assert np.abs(q[(0, 0)][0][-1, :] - q[(0, 1)][0][0, :]).max() < 0.05
    corners = np.array([q[(0, 0)][0][-1, -1], q[(1, 0)][0][-1, 0], q[(0, 1)][0][0, -1], q[(1, 1)][0][0, 0]])
    assert np.ptp(corners, 0).max() < 0.05 and abs(corners[0][2] + np.linalg.norm(corners[0])) < 1e-6 * R


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = p.add_subparsers(dest='cmd', required=True)
    i = sp.add_parser('inspect'); i.add_argument('rasters', nargs='+')
    f = sp.add_parser('fuse')
    f.add_argument('--base', required=True); f.add_argument('--detail', required=True); f.add_argument('--out', required=True)
    f.add_argument('--blend-m', type=float, default=1000)
    f.add_argument('--fit-stride', type=int, default=8)
    f.add_argument('--bias', choices=['plane', 'none'], default='plane',
                   help='remove the fitted planar bias (plane) or only disclose it (none)')
    f.add_argument('--vertical-datum', default='unknown', help='stated vertical datum of both sources')
    t = sp.add_parser('tile')
    t.add_argument('--base', required=True); t.add_argument('--fusion', required=True); t.add_argument('--out', required=True)
    t.add_argument('--global-zoom', type=int, default=9); t.add_argument('--max-zoom', type=int, default=15)
    t.add_argument('--regional-bounds', type=lambda v: [float(x) for x in v.split(',')], metavar='W,S,E,N',
                   help='extend the regional levels beyond the residual extent')
    t.add_argument('--only-zoom', type=lambda s: [int(v) for v in s.split(',')])
    t.add_argument('--zoom-bounds', action='append', metavar='Z=W,S,E,N',
                   type=lambda v: (int(v.split('=')[0]), [float(x) for x in v.split('=')[1].split(',')]),
                   help='narrower W,S,E,N for one regional zoom (repeatable): polar geographic tiles are slivers')
    t.add_argument('--error-frac', type=float, default=0.1, help='mesh max error as a fraction of vertex spacing')
    t.add_argument('--ellipsoid', type=float, nargs=2, required=True, metavar=('A_M', 'C_M'),
                   help='renderer ellipsoid radii for tile centres and bounding spheres')
    t.add_argument('--workers', type=int, default=min(8, os.cpu_count()),
                   help='forked workers; sources are shared copy-on-write, each worker adds ~100 MB')
    t.add_argument('--name', default='Fused terrain'); t.add_argument('--attribution', default='')
    pt = sp.add_parser('polar-tile', help='square 3D Tiles cap on a polar stereographic detail grid (#144)')
    pt.add_argument('--base', required=True); pt.add_argument('--fusion', required=True); pt.add_argument('--out', required=True)
    pt.add_argument('--max-level', type=int, default=7, help='deepest quadtree level (level 0 = the whole detail square)')
    pt.add_argument('--level-radius', action='append', metavar='L=METRES',
                    type=lambda v: (int(v.split('=')[0]), float(v.split('=')[1])),
                    help='only tile level L within this distance of the pole (repeatable)')
    pt.add_argument('--skirt-cells', type=float, default=1.0, help='skirt depth in vertex spacings')
    pt.add_argument('--ellipsoid', type=float, nargs=2, required=True, metavar=('A_M', 'C_M'))
    pt.add_argument('--workers', type=int, default=min(8, os.cpu_count()))
    sp.add_parser('selftest')
    args = p.parse_args()
    if getattr(args, 'zoom_bounds', None):
        args.zoom_bounds = dict(args.zoom_bounds)
    if getattr(args, 'level_radius', None):
        args.level_radius = dict(args.level_radius)
    {'inspect': cmd_inspect, 'fuse': cmd_fuse, 'tile': cmd_tile, 'polar-tile': cmd_polar_tile,
     'selftest': cmd_selftest}[args.cmd](args)


if __name__ == '__main__':
    main()
