#!/usr/bin/env python3
"""Offline planetary DEM tooling: inspect, fuse, tile (issue #50).

    dem.py inspect RASTER...
    dem.py fuse  --base GLOBAL.tif --detail REGIONAL.tif --out DIR [--blend-m 1000]
    dem.py tile  --base GLOBAL.tif --fusion DIR --out PYRAMID [--global-zoom 9 --max-zoom 15]
    dem.py fields --base GLOBAL.tif --fusion DIR --out PYRAMID [--max-px 1024]
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

`tile` (or `fields` alone, on an existing pyramid) also writes
`fusion-fields.bin`: base height, residual, taper weight and detail coverage on
one coarse grid over the residual extent, described in terrain-product.json
under `debugFields`. The viewer's fusion debug views read it (#135); heights
never do.

Tile-level validation (edges, parent/child, registration, control points) runs
on the written pyramid with the viewer's own decoder: scripts/validate-terrain.mjs.

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
    """Full-resolution base raster as a read-only array plus its geotransform.

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
    return arr, ds.GetGeoTransform(), b.GetNoDataValue()


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
    if not base_ds.GetSpatialRef().IsGeographic():
        raise SystemExit('base must be in a geographic CRS')
    radius = base_ds.GetSpatialRef().GetSemiMajor()
    base, base_gt, base_nd = open_base(args.base)

    det_ds = gdal.Open(args.detail)
    if abs(det_ds.GetSpatialRef().GetSemiMajor() - radius) > 1e-3:
        raise SystemExit('base and detail must share the reference body/sphere')
    gt = geographic_grid(det_ds)
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

    lon = gt[0] + (np.arange(w) + 0.5) * gt[1]
    lat = gt[3] + (np.arange(h) + 0.5) * gt[5]
    base_on = np.empty((h, w), np.float32)
    for r0 in range(0, h, 256):  # small chunks: the cubic kernel holds 16 gathers
        la = lat[r0:r0 + 256, None]
        base_on[r0:r0 + 256] = cubic(base, base_gt, np.broadcast_to(lon, (la.shape[0], w)),
                                     np.broadcast_to(la, (la.shape[0], w)), wrap_lon=True)
    if base_nd is not None:
        # A base nodata value anywhere in a kernel would poison the fit.
        assert not np.any(base_on <= base_nd + 1), 'base nodata inside detail extent'

    lon0, lat0 = float(lon[w // 2]), float(lat[h // 2])
    m_per_deg = math.pi / 180 * radius
    east_km = (lon - lon0) * m_per_deg * math.cos(math.radians(lat0)) / 1000
    north_km = (lat - lat0) * m_per_deg / 1000

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
    blend_px = args.blend_m / (abs(gt[5]) * m_per_deg)
    mem = gdal.GetDriverByName('MEM')
    mask = mem.Create('', w + 2, h + 2, 1, gdal.GDT_Byte)
    mb = mask.GetRasterBand(1)
    mb.Fill(1)
    mb.WriteArray((~covered).view(np.uint8), 1, 1)
    prox = mem.Create('', w + 2, h + 2, 1, gdal.GDT_Float32)
    gdal.ComputeProximity(mb, prox.GetRasterBand(1),
                          ['VALUES=1', 'DISTUNITS=PIXEL', f'MAXDIST={math.ceil(blend_px) + 1}', 'NODATA=-1'])
    mask = mb = None
    # ponytail: distance in north-pixel units; east pixels are cos(lat) narrower (~5% at Jezero).
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
        'grid': {'geotransform': list(gt), 'size': [w, h], 'crs': base_ds.GetSpatialRef().ExportToProj4()},
        'verticalDatum': args.vertical_datum,
        'kernel': 'base: Catmull-Rom, pixel-is-area, longitude wraps',
        'coverageFraction': float(covered.mean()),
        'registration': {
            'model': 'detail − base = offset + slopeEast·east + slopeNorth·north (least squares)',
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
        'products': {'residual': 'residual.tif', 'coverage': 'coverage.tif', 'weight': 'weight.tif', 'fused': 'fused.tif'},
    }
    del full, band
    srs = base_ds.GetProjection()
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


def pick_level(levels, spacing_deg):
    """Coarsest pyramid level whose pixels are still no larger than the vertex
    spacing — enough detail without aliasing far finer data into a tile."""
    best = 0
    for i, (_, gt) in enumerate(levels):
        if gt[1] <= spacing_deg * 1.0001:
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


def tile_job(job):
    z, x0, x1, y = job
    S = _T
    w, s, e, n = tile_bounds(z, x0, y)
    spacing = (n - s) / (GRID - 1)
    bl = S['base'][pick_level(S['base'], spacing)]
    rl = S['residual'][pick_level(S['residual'], spacing)]
    rb = S['residual_bounds']
    # One extra vertex ring outside the tile, so normals at shared edges come
    # from the same neighbours on both sides and shading has no tile seams.
    frac = np.arange(-1, GRID + 1) / (GRID - 1)
    a, c = S['ellipsoid']
    max_err = S['error_frac'] * spacing * math.pi / 180 * S['ellipsoid'][0]
    written = verts = 0
    for x in range(x0, x1):
        w, s, e, n = tile_bounds(z, x, y)
        G = GRID + 2
        lon = np.broadcast_to(w + frac * (e - w), (G, G))
        lat = np.broadcast_to(np.clip(s + frac * (n - s), -90, 90)[:, None], (G, G))
        hgt = cubic(bl[0], bl[1], lon, lat, wrap_lon=True).astype(np.float64)
        if w < rb[2] and e > rb[0] and s < rb[3] and n > rb[1]:
            hgt = hgt + bilinear(rl[0], rl[1], lon, lat, outside=0.0)
        P = ecef(lon, lat, hgt, a, c)
        nrm = np.cross(P[1:-1, 2:] - P[1:-1, :-2], P[2:, 1:-1] - P[:-2, 1:-1]).reshape(-1, 3)
        ln = np.linalg.norm(nrm, axis=1, keepdims=True)
        la, lo = np.radians(lat[1:-1, 1:-1]).ravel(), np.radians(lon[1:-1, 1:-1]).ravel()
        up = np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], 1)
        nrm = np.where(ln > 1e-9, nrm / np.maximum(ln, 1e-12), up)  # poles: degenerate lattice
        data, nv, _ = encode_tile(hgt[1:-1, 1:-1].ravel(), (w, s, e, n), max_err, S['ellipsoid'], nrm)
        d = os.path.join(S['out'], str(z), str(x))
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, f'{y}.terrain'), 'wb') as f:
            f.write(gzip.compress(data, 6, mtime=0))
        written += 1; verts += nv
    return written, verts


def cmd_tile(args):
    t0 = time.time()
    fusion = json.load(open(os.path.join(args.fusion, 'fusion.json')))
    levels, ds, b = load_base_levels(args.base)
    # Only the overviews some generated zoom actually samples are read into
    # memory — regional zooms too: with a low --global-zoom they still pick overviews.
    needed = {pick_level(levels, 180 / 2 ** z / (GRID - 1)) for z in range(args.max_zoom + 1)}
    for li in sorted(needed - {0}):
        levels[li] = (b.GetOverview(li - 1).ReadAsArray(), levels[li][1])  # native dtype: half the RAM of float32
        print(f'  base overview {li}: {levels[li][0].shape[1]}×{levels[li][0].shape[0]}')

    rds = gdal.Open(os.path.join(args.fusion, 'residual.tif'))
    residual = rds.GetRasterBand(1).ReadAsArray()
    rgt = rds.GetGeoTransform()
    rbounds = (rgt[0], rgt[3] + rgt[5] * rds.RasterYSize, rgt[0] + rgt[1] * rds.RasterXSize, rgt[3])
    _T.update(base=levels, residual=box_pyramid(residual, rgt), residual_bounds=rbounds, out=args.out,
              error_frac=args.error_frac, ellipsoid=tuple(args.ellipsoid))
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
            dx, dy = 360 / nx, 180 / ny
            xr = (int((tb[0] + 180) // dx), int(math.ceil((tb[2] + 180) / dx)) - 1)
            yr = (int((tb[1] + 90) // dy), int(math.ceil((tb[3] + 90) / dy)) - 1)
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
                   'regionalBounds': list(tb), 'residualBounds': list(rbounds)},
        'sources': {'canonical': fusion['base'], 'detail': fusion['detail']},
        'registration': {k: reg[k] for k in ('model', 'centroid', 'offsetM', 'slopeEastMPerKm',
                                              'slopeNorthMPerKm', 'tiltDeg', 'raw', 'afterPlane', 'removed', 'note')},
        'taper': fusion['taper'],
        'residual': fusion['residual'],
        'tileCount': total,
    }
    if args.debug_fields_max_px > 0:
        arrays, grid = debug_fields(args.fusion, levels, b, args.debug_fields_max_px)
        product['debugFields'] = write_debug_fields(args.out, arrays, grid)
    with open(os.path.join(args.out, 'terrain-product.json'), 'w') as f:
        json.dump(product, f, indent=2)
    print(f'wrote {total:,} tiles to {args.out} ({time.time() - t0:.0f}s)')


# ---------------------------------------------------------------------------
# debug fields (#135)

FIELDS_FILE = 'fusion-fields.bin'


def field_grid(ds, max_px):
    """Output size for a raster read down to at most max_px on its long side,
    keeping its extent: cells cover the same bounds, just coarser."""
    w, h = ds.RasterXSize, ds.RasterYSize
    k = max(1.0, max(w, h) / max_px)
    return max(1, round(w / k)), max(1, round(h / k))


def read_average(path, size):
    """Box-average a single-band raster to `size`, streamed by the warper so
    the full-resolution product is never held in memory. Warp rather than a
    decimating read: RasterIO averages a Byte band in Byte and rounds the
    coverage fraction to 0/1, losing exactly the boundary cells."""
    ds = gdal.Warp('', path, format='MEM', width=size[0], height=size[1],
                   resampleAlg='average', outputType=gdal.GDT_Float32)
    return ds.GetRasterBand(1).ReadAsArray()


def debug_fields(fusion_dir, base_levels, base_band, max_px):
    """Base, residual, weight and coverage on one grid over the residual extent.

    Residual, weight and coverage are box averages of the fuse products, so a
    cell straddling the coverage edge holds the covered *fraction* — a value
    strictly between 0 and 1 marks the boundary. Base is the same Catmull-Rom
    base the tiles use, sampled at cell centres from the pyramid level that
    matches the cell size. Returns (arrays, grid) where grid describes the layout.
    """
    rds = gdal.Open(os.path.join(fusion_dir, 'residual.tif'))
    gt = rds.GetGeoTransform()
    W, H = field_grid(rds, max_px)
    bounds = (gt[0], gt[3] + gt[5] * rds.RasterYSize, gt[0] + gt[1] * rds.RasterXSize, gt[3])
    cell_lon, cell_lat = (bounds[2] - bounds[0]) / W, (bounds[3] - bounds[1]) / H
    residual = read_average(os.path.join(fusion_dir, 'residual.tif'), (W, H))
    weight = read_average(os.path.join(fusion_dir, 'weight.tif'), (W, H))
    coverage = read_average(os.path.join(fusion_dir, 'coverage.tif'), (W, H))

    li = pick_level(base_levels, cell_lat)
    arr, bgt = base_levels[li]
    if arr is None:  # an overview no generated zoom needed
        arr = base_band.GetOverview(li - 1).ReadAsArray()
    lon = bounds[0] + (np.arange(W) + 0.5) * cell_lon
    lat = bounds[3] - (np.arange(H) + 0.5) * cell_lat
    base = cubic(arr, bgt, *np.meshgrid(lon, lat), wrap_lon=True).astype(np.float32)
    grid = {'bounds': [float(v) for v in bounds], 'width': W, 'height': H,
            'rowOrder': 'north-to-south', 'registration': 'pixel-is-area',
            'cellDeg': [cell_lon, cell_lat], 'baseLevel': li}
    return {'baseM': base, 'residualM': residual, 'weight': weight, 'coverage': coverage}, grid


def write_debug_fields(out, arrays, grid):
    """fusion-fields.bin: float32 base and residual, then uint8 weight and
    coverage (value / 255), each a full row-major grid, little-endian. Returns
    the `debugFields` description that goes in terrain-product.json."""
    layout, offset, chunks = [], 0, []
    specs = [('baseM', 'float32', 'm', 'canonical base height, same datum as the tiles'),
             ('residualM', 'float32', 'm', 'tapered detail residual added to the base (box average)'),
             ('weight', 'uint8', None, 'taper weight 0..1: 1 = full detail, 0 = base only (box average)'),
             ('coverage', 'uint8', None, 'fraction of the cell where the detail DEM has data; 0 < c < 1 is the coverage boundary')]
    for name, kind, units, desc in specs:
        a = arrays[name]
        if kind == 'float32':
            data = np.ascontiguousarray(a, dtype='<f4')
            entry = {'name': name, 'type': kind, 'offset': offset, 'units': units, 'description': desc}
        else:
            data = np.ascontiguousarray(np.clip(np.rint(a * 255), 0, 255), dtype=np.uint8)
            entry = {'name': name, 'type': kind, 'offset': offset, 'scale': 1 / 255, 'description': desc}
        layout.append(entry)
        chunks.append(data.tobytes())
        offset += data.nbytes
    with open(os.path.join(out, FIELDS_FILE), 'wb') as f:
        for c in chunks:
            f.write(c)
    return {'path': FIELDS_FILE, 'byteLength': offset, 'byteOrder': 'little-endian', 'grid': grid,
            'fields': layout,
            'note': 'diagnostic only (fusion debug views, #135); the height field is the tiles'}


def load_base_levels(path):
    """Base level 0 plus overview geotransforms; overview arrays stay unread (None)."""
    base, base_gt, _ = open_base(path)
    ds = gdal.Open(path)
    b = ds.GetRasterBand(1)
    levels = [(base, base_gt)]
    W, H = ds.RasterXSize, ds.RasterYSize
    for i in range(b.GetOverviewCount()):
        o = b.GetOverview(i)
        levels.append((None, (base_gt[0], base_gt[1] * W / o.XSize, 0, base_gt[3], 0, base_gt[5] * H / o.YSize)))
    return levels, ds, b


def cmd_fields(args):
    """(Re)write fusion-fields.bin for an existing pyramid and record it in terrain-product.json."""
    product_path = os.path.join(args.out, 'terrain-product.json')
    if not os.path.exists(product_path):
        raise SystemExit(f'{product_path} not found: run `dem.py tile` first')
    levels, _ds, band = load_base_levels(args.base)
    arrays, grid = debug_fields(args.fusion, levels, band, args.max_px)
    product = json.load(open(product_path))
    product['debugFields'] = write_debug_fields(args.out, arrays, grid)
    with open(product_path, 'w') as f:
        json.dump(product, f, indent=2)
    print(f"wrote {FIELDS_FILE}: {grid['width']}×{grid['height']} cells over {grid['bounds']}")


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
    selftest_fields()
    print(f'selftest ok: {nv} vertices, {nt} triangles from {GRID * GRID}; debug fields ok')


def selftest_fields():
    """fusion-fields.bin round trip on a synthetic fuse product: layout, box
    averages, the fractional coverage edge and the base kernel."""
    import tempfile
    srs = 'GEOGCS["Mars 2000",DATUM["D_Mars_2000",SPHEROID["Mars_2000_IAU_IAG",3396190,0]],PRIMEM["Greenwich",0],UNIT["Degree",0.0174532925199433]]'
    with tempfile.TemporaryDirectory() as d:
        gt = (77.0, 0.01, 0, 18.4, 0, -0.01)  # 40×20 px detail grid
        covered = np.zeros((20, 40), np.uint8)
        covered[:, :28] = 1                    # detail ends 3 px into cell 5
        residual = np.where(covered, 4.0, 0.0).astype(np.float32)
        weight = covered.astype(np.float32)
        write_tif(os.path.join(d, 'residual.tif'), residual, gt, srs)
        write_tif(os.path.join(d, 'weight.tif'), weight, gt, srs)
        write_tif(os.path.join(d, 'coverage.tif'), covered, gt, srs, dtype=gdal.GDT_Byte)
        base = np.add.outer(np.linspace(1000, -1000, 180), np.zeros(360)).astype(np.float32)  # north high
        levels = [(base, (-180, 1, 0, 90, 0, -1))]
        arrays, grid = debug_fields(d, levels, None, 8)  # 40×20 → 8×4: 5×5 px per cell
        assert (grid['width'], grid['height']) == (8, 4), grid
        assert np.allclose(grid['bounds'], (77.0, 18.2, 77.4, 18.4))
        cov = arrays['coverage'][0]
        assert np.allclose(cov, [1, 1, 1, 1, 1, 0.6, 0, 0]), cov  # the boundary cell keeps its fraction
        assert np.allclose(arrays['residualM'][0], [4, 4, 4, 4, 4, 2.4, 0, 0])
        expect = cubic(base, levels[0][1], np.array([77.025]), np.array([18.375]), wrap_lon=True)[0]
        assert abs(arrays['baseM'][0, 0] - expect) < 1e-3
        meta = write_debug_fields(d, arrays, grid)
        raw = open(os.path.join(d, FIELDS_FILE), 'rb').read()
        assert len(raw) == meta['byteLength'] == 32 * (4 + 4 + 1 + 1)
        by = {f['name']: f for f in meta['fields']}
        assert all(f['offset'] % 4 == 0 for f in meta['fields'] if f['type'] == 'float32')
        r = np.frombuffer(raw, '<f4', 32, by['residualM']['offset']).reshape(4, 8)
        c = np.frombuffer(raw, np.uint8, 32, by['coverage']['offset']).reshape(4, 8)
        assert np.allclose(r, arrays['residualM']) and c[0, 5] == 153 and c[0, 0] == 255 and c[0, 7] == 0


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
    t.add_argument('--error-frac', type=float, default=0.1, help='mesh max error as a fraction of vertex spacing')
    t.add_argument('--ellipsoid', type=float, nargs=2, required=True, metavar=('A_M', 'C_M'),
                   help='renderer ellipsoid radii for tile centres and bounding spheres')
    t.add_argument('--workers', type=int, default=min(8, os.cpu_count()),
                   help='forked workers; sources are shared copy-on-write, each worker adds ~100 MB')
    t.add_argument('--name', default='Fused terrain'); t.add_argument('--attribution', default='')
    t.add_argument('--debug-fields-max-px', type=int, default=1024,
                   help='long side of fusion-fields.bin for the fusion debug views; 0 skips it')
    d = sp.add_parser('fields', help='(re)write fusion-fields.bin for an existing pyramid')
    d.add_argument('--base', required=True); d.add_argument('--fusion', required=True); d.add_argument('--out', required=True)
    d.add_argument('--max-px', type=int, default=1024)
    sp.add_parser('selftest')
    args = p.parse_args()
    {'inspect': cmd_inspect, 'fuse': cmd_fuse, 'tile': cmd_tile, 'fields': cmd_fields, 'selftest': cmd_selftest}[args.cmd](args)


if __name__ == '__main__':
    main()
