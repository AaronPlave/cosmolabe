#!/usr/bin/env python3
"""Cube-face map imagery pyramids for the cube-sphere experiment (issue #149).

    cube_imagery.py fixture --pattern grid|registration --out DIR [--global-level 3 --region …]
    cube_imagery.py nac --source COG --out DIR [--region …]
    cube_imagery.py composite --base WAC --detail NAC --out DIR --global-level 6 [--region …]
    cube_imagery.py coregister --base WAC --detail NAC [--level 8 --samples 40 --out JSON]
    cube_imagery.py selftest

Imagery is preprocessed into the faces, bases and `{face}/{level}/{x}/{y}`
quadtrees of packages/three/src/surface/CubeSphere.ts (taken from dem.py's
CUBE_BASES, which scripts/validate-cube-terrain.mjs checks against the compiled
module), but its levels and extent are its own: the viewer drapes an imagery
tile of any level onto whatever geometry tile covers it
(packages/three/src/surface/CubeImagery.ts, CubeImageryLayer.ts).

Registration (CubeImagery.ts states the same convention). A tile file is
(T + 2g)² pixels, T interior pixels across the tile's face square and a gutter
of g pixels per side. Column i grows with face u, row j (from the top of the
file) shrinks with face v; pixel corners are integers, so pixel (i, j) has its
centre at u = u0 + (i + 0.5 − g)·Δ/T, v = v1 − (j + 0.5 − g)·Δ/T. Every pixel,
gutters included, is evaluated at the geocentric direction normalize(N + uU + vV)
of its sample points; past a face edge that direction lies on the neighbouring
face, so gutters hold the neighbour's content and filtering across tile and face
edges reads continuous imagery. Each output pixel averages SS×SS sample points
inside its footprint (box prefilter), so coarse levels are not point-sampled.

Patterns:
  grid          A continuous diagnostic image defined on directions alone:
                10°/1°/0.1°/0.01° graticules, cube face edges, and bullseye markers
                (rings at 12 km, 3 km, 750 m, 188 m, 47 m, 12 m) with uniquely coloured
                centres at control points: Shackleton, both poles, the
                antimeridian, a face edge and a face corner. markers.json lists
                each marker's expected tile and pixel at every level that holds it.
  registration  Texel coordinates as colour: R = interior column (0–255), G =
                interior row counted from the bottom, B = 32·face + level. A
                rendered pixel decodes to (face, level, u, v) to compare with the
                ray-cast body-fixed point it shows (scripts/capture-cube-imagery.mjs).
                Linear data, never colour-converted.
nac             The LROC NAC South Pole controlled mosaic (USGS/LROC, Nov 2025;
                1 m, polar stereographic, COG with overviews), read remotely by
                window from the overview finer than half an output pixel and
                box-filtered. Nodata (0) is transparent; outside 81.5°S the layer is
                transparent too, so the terrain's own shading shows there.
composite       Global base (the LROC WAC 100 m mosaic, equirectangular, wrapping at
                the antimeridian) on every face to --global-level, with the NAC
                detail composited over it by coverage on every tile that can hold
                NAC pixels, and the NAC regions deeper. Opaque grey JPEG: outside the
                NAC footprint and in its nodata gaps the WAC shows, at every level.

Requires numpy and GDAL's Python bindings (as dem.py).
"""
import argparse, hashlib, json, math, multiprocessing as mp, os, sys, time
import numpy as np

sys.dont_write_bytecode = True  # importing dem.py must not litter scripts/terrain with __pycache__
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dem import CUBE_BASES, CUBE_FACES, parse_cube_region  # noqa: E402
from osgeo import gdal, osr  # noqa: E402

gdal.UseExceptions()
FACE_INDEX = {f: i for i, f in enumerate(CUBE_FACES)}
R_KM = 1737.4

# ---------------------------------------------------------------------------
# Tile geometry


def tile_rect(L, x, y):
    size = 2.0 / 2 ** L
    return -1 + x * size, -1 + y * size, size


def pixel_samples(L, x, y, T, g, ss):
    """(u, v) of SS×SS sample points per pixel, shape (rows, cols, ss*ss)."""
    u0, v0, size = tile_rect(L, x, y)
    n = T + 2 * g
    off = (np.arange(ss) + 0.5) / ss
    cols = (np.arange(n)[:, None] + off[None, :]).ravel()  # sub-columns
    rows = (np.arange(n)[:, None] + off[None, :]).ravel()
    u = u0 + (cols - g) * size / T
    v = v0 + size - (rows - g) * size / T
    U, V = np.meshgrid(u, v)  # (n*ss, n*ss)
    U = U.reshape(n, ss, n, ss).transpose(0, 2, 1, 3).reshape(n, n, ss * ss)
    V = V.reshape(n, ss, n, ss).transpose(0, 2, 1, 3).reshape(n, n, ss * ss)
    return U, V


def directions(face, u, v):
    n_, a_, b_ = (np.array(e, np.float64) for e in CUBE_BASES[face])
    p = n_ + u[..., None] * a_ + v[..., None] * b_
    return p / np.linalg.norm(p, axis=-1, keepdims=True)


def lonlat(d):
    return (np.degrees(np.arctan2(d[..., 1], d[..., 0])),
            np.degrees(np.arctan2(d[..., 2], np.hypot(d[..., 0], d[..., 1]))))


def sin_cos_deg(deg):
    """Exact (0, ±1) at multiples of 90°, as CubeSphere.ts sinCosDeg: the poles and the
    0/180° meridians then land on exact child boundaries, owned as the viewer owns them."""
    r = math.fmod(deg, 360.0)
    q = math.floor(r / 90 + 0.5)  # JavaScript Math.round (half up), not Python's half-to-even
    a = math.radians(r - 90 * q)
    s, c = math.sin(a), math.cos(a)
    return [(s, c), (c, -s), (-s, -c), (-c, s)][q % 4]


def unit(lat, lon):
    (sla, cla), (slo, clo) = sin_cos_deg(lat), sin_cos_deg(lon)
    return np.array([cla * clo, cla * slo, sla]) + 0.0


def tile_extent(face, L, x, y):
    """Centre direction and angular radius (rad) of a tile."""
    u0, v0, size = tile_rect(L, x, y)
    c = directions(face, np.array([u0 + size / 2]), np.array([v0 + size / 2]))[0]
    cu, cv = np.meshgrid([u0, u0 + size], [v0, v0 + size])
    k = directions(face, cu.ravel(), cv.ravel())
    return c, float(np.arccos(np.clip(k @ c, -1, 1)).max())


def select_tiles(global_level, regions, keep=None):
    """Global levels on every face, deeper levels within region radii; ancestors always included."""
    wanted = set()
    max_level = max([global_level, *(L for r in regions for L in r['levels'])])
    frontier = [(f, 0, 0, 0) for f in CUBE_FACES]
    while frontier:
        nxt = []
        for f, L, x, y in frontier:
            ok = L <= global_level
            if not ok:
                c, rad = tile_extent(f, L, x, y)
                for r in regions:
                    km = r['levels'].get(L)
                    if km is not None and math.acos(min(1.0, float(c @ r['direction']))) - rad < km / R_KM:
                        ok = True
                        break
            if ok and keep is not None and L > 0 and not keep(f, L, x, y):
                ok = False
            if ok:
                wanted.add((f, L, x, y))
                if L < max_level:
                    nxt += [(f, L + 1, 2 * x + dx, 2 * y + dy) for dy in (0, 1) for dx in (0, 1)]
        frontier = nxt
    return sorted(wanted, key=lambda k: (k[1], FACE_INDEX[k[0]], k[3], k[2]))


# ---------------------------------------------------------------------------
# Diagnostic patterns (functions of direction only)

MARKERS = [  # name, lat, lon, centre colour
    ('shackleton', -89.67, 129.78, (255, 40, 40)),
    ('south-pole', -90.0, 0.0, (40, 255, 40)),
    ('north-pole', 90.0, 0.0, (40, 120, 255)),
    ('antimeridian-equator', 0.0, 180.0, (255, 255, 0)),
    ('antimeridian-60s', -60.0, 180.0, (255, 0, 255)),
    ('antimeridian-88s', -88.0, 180.0, (0, 255, 255)),
    ('edge-px-nz', -45.0, 0.0, (255, 140, 0)),
    ('corner-px-py-nz', -35.26438968, 45.0, (160, 60, 255)),
]
RING_KM = [12.0, 3.0, 0.75, 0.1875, 0.046875, 0.01171875]
# Marker-coloured annuli between ring pairs (0,1), (2,3), (4,5): identifiable from orbit down to metres.
ANNULI_KM = [(RING_KM[k + 1] * 1.12, RING_KM[k] * 0.9) for k in (0, 2, 4)]


def line_mask(dist, width):
    return dist < width / 2


def grid_pattern(d, texel_deg):
    """RGB float in [0, 1] for unit directions d (..., 3), box-filtered at a texel of
    `texel_deg` (arc): a feature narrower than a few texels is drawn as its area-average
    colour rather than point-sampled into moiré, as a mip level of one image would be."""
    lon, lat = lonlat(d)
    coslat = np.cos(np.radians(lat))
    # Base: a 10° latitude/longitude checker, so pole convergence and wrap are visible.
    rgb = np.empty(d.shape[:-1] + (3,))
    checker = ((np.floor((lat + 90) / 10) + np.floor((lon + 180) / 10)) % 2).astype(bool)
    rgb[...] = np.where(checker[..., None], [0.30, 0.32, 0.36], [0.42, 0.40, 0.36])
    for spacing, colour in ((10, (1, 1, 1)), (1, (0.85, 0.85, 0.85)), (0.1, (1.0, 0.9, 0.2)), (0.01, (0.2, 0.9, 1.0))):
        w = spacing * 0.04  # line width, degrees of arc
        if spacing < 3 * texel_deg:  # unresolved: the lines' covered fraction, latitude and meridian sets
            f = min(1.0, 2 * w / spacing)
            rgb = rgb * (1 - f) + np.array(colour) * f
            continue
        dlat = np.abs((lat + 90) - np.round((lat + 90) / spacing) * spacing)
        on = line_mask(dlat, w)
        # Meridians in arc length; switch to a 10× coarser set where they would crowd (near the poles).
        for s in (spacing, spacing * 10):
            dlon = np.abs((lon + 180) - np.round((lon + 180) / s) * s) * coslat
            sel = (coslat * s >= spacing * 0.5) if s == spacing else (coslat * spacing < spacing * 0.5)
            on |= sel & line_mask(dlon, w)
        rgb[on] = colour
    # Cube face edges: |a| = |b| for the two largest components.
    ad = np.abs(d)
    srt = np.sort(ad, axis=-1)
    edge = (srt[..., 2] - srt[..., 1]) / srt[..., 2]  # tan-ish distance from the nearest face edge
    rgb[edge < 2e-4] = (1.0, 0.0, 0.8)
    # Bullseye markers: every marker's outer features first, then every marker's
    # inner ones (within its 3 km ring), so Shackleton and the pole 10 km apart each
    # keep their own centre where the other's 12 km ring and annulus overlap them.
    texel_km = texel_deg * math.pi / 180 * R_KM
    inner_km = RING_KM[1] * 1.12
    dists = [(np.arccos(np.clip(d @ unit(la, lo), -1, 1)) * R_KM, np.array(colour) / 255) for _, la, lo, colour in MARKERS]
    for outer in (True, False):
        for dist_km, colour in dists:
            zone = dist_km >= inner_km if outer else dist_km < inner_km
            for k, r in enumerate(RING_KM):
                if r < texel_km:
                    break
                rgb[zone & (np.abs(dist_km - r) < r * 0.08)] = (0, 0, 0) if k % 2 == 0 else (1, 1, 1)
            for lo_km, hi_km in ANNULI_KM:
                rgb[zone & (dist_km > lo_km) & (dist_km < hi_km)] = colour
            if not outer:
                rgb[dist_km < RING_KM[-1] * 0.5] = colour
    return rgb


def registration_pattern(face, L, x, y, T, g):
    n = T + 2 * g
    i = np.arange(n)
    col = np.clip(i - g, 0, T - 1)
    row_up = np.clip(T - 1 - (i - g), 0, T - 1)
    img = np.zeros((n, n, 3), np.uint8)
    img[..., 0] = col[None, :]
    img[..., 1] = row_up[:, None]
    img[..., 2] = 32 * FACE_INDEX[face] + L
    return img


# ---------------------------------------------------------------------------
# Georeferenced rasters (the NAC South Pole mosaic, the WAC global mosaic)

_SRC = {}
WINDOW_CAP = 16_000_000
JPEG_QUALITY = 90  # source pixels per tile window; near the poles an equirectangular window spans every longitude


def raster_open(path):
    if path not in _SRC:
        ds = gdal.Open(path)
        srs = osr.SpatialReference(wkt=ds.GetProjection())
        geog = srs.CloneGeogCS()
        a, inv_f = geog.GetSemiMajor(), geog.GetInvFlattening()
        if inv_f != 0 or abs(a - R_KM * 1000) > 1e-6:
            raise SystemExit(f'{path}: CRS is not the 1737.4 km sphere (a={a}, 1/f={inv_f}); planetocentric ≠ geocentric handling needed')
        geog.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
        tr = osr.CoordinateTransformation(geog, srs)
        gt = ds.GetGeoTransform()
        band = ds.GetRasterBand(1)
        levels = [(gt[1], band)] + [(gt[1] * ds.RasterXSize / band.GetOverview(k).XSize, band.GetOverview(k)) for k in range(band.GetOverviewCount())]
        # A global cylindrical raster wraps in longitude: windows then cross the antimeridian instead of spanning the globe.
        x0, x1 = (tr.TransformPoint(lon, 0.0)[0] for lon in (-180.0, 180.0))
        period = x1 - x0 if abs(abs(x1 - x0) - ds.RasterXSize * gt[1]) < 2 * gt[1] else None
        _SRC[path] = dict(ds=ds, gt=gt, tr=tr, levels=levels, nodata=band.GetNoDataValue(), period=period)
    return _SRC[path]


def read_window(band, c0, r0, w, h, tries=6):
    """ReadAsArray with retries: a remote COG read can fail transiently (a short or empty
    HTTP range) past GDAL's own HTTP retries, and one failure would end a long build."""
    for k in range(tries):
        try:
            return band.ReadAsArray(c0, r0, w, h)
        except RuntimeError:
            if k == tries - 1:
                raise
            time.sleep(2 ** k)


def raster_tile(path, face, L, x, y, T, g, ss):
    """(value, alpha) per output pixel, each (n, n) float: bilinear from the source overview
    finer than ~0.4 sample spacing, box-averaged over the SS×SS samples; nodata → alpha 0."""
    src = raster_open(path)
    U, V = pixel_samples(L, x, y, T, g, ss)
    d = directions(face, U, V)
    lon, lat = lonlat(d)
    shape = lon.shape
    pts = np.array(src['tr'].TransformPoints(np.column_stack([lon.ravel(), lat.ravel()]).tolist()))[:, :2]
    px, py = pts[:, 0], pts[:, 1]
    gt = src['gt']
    if src['period']:  # unwrap about the tile centre, so a tile across the antimeridian reads two narrow windows
        u0, v0, size = tile_rect(L, x, y)
        cl, _ = lonlat(directions(face, np.array([u0 + size / 2]), np.array([v0 + size / 2])))
        xc = src['tr'].TransformPoint(float(cl[0]), 0.0)[0]
        px = xc + np.mod(px - xc + src['period'] / 2, src['period']) - src['period'] / 2
    u0, v0, size = tile_rect(L, x, y)
    sample_m = size / T / ss * R_KM * 1000 * 0.4  # conservative: corner texels are ~2.6× smaller than the centre
    fine = 0
    for k, (r, _) in enumerate(src['levels']):
        if r <= max(sample_m, src['levels'][0][0]):
            fine = k
    for res, band in src['levels'][fine:]:  # coarser while the window is too large (equirectangular near a pole)
        cols = (px - gt[0]) / res - 0.5
        rows = (gt[3] - py) / res - 0.5
        lo_c, hi_c = (-1, band.XSize) if not src['period'] else (-band.XSize, 2 * band.XSize)
        ok = np.isfinite(cols) & np.isfinite(rows) & (cols > lo_c) & (rows > -1) & (cols < hi_c) & (rows < band.YSize)
        if not ok.any():
            return np.zeros(shape[:2]), np.zeros(shape[:2])
        c0, c1 = int(math.floor(cols[ok].min())), int(math.ceil(cols[ok].max()) + 1)
        r0, r1 = int(max(0, math.floor(rows[ok].min()))), int(min(band.YSize - 1, math.ceil(rows[ok].max()) + 1))
        if not src['period']:
            c0, c1 = max(0, c0), min(band.XSize - 1, c1)
        if (c1 - c0 + 1) * (r1 - r0 + 1) <= WINDOW_CAP:
            break
    h = r1 - r0 + 1
    if c0 >= 0 and c1 < band.XSize:
        win = read_window(band, c0, r0, c1 - c0 + 1, h)
    else:  # wrapped: columns modulo the width, read in contiguous runs
        idx = np.mod(np.arange(c0, c1 + 1), band.XSize)
        runs = np.split(idx, np.flatnonzero(np.diff(idx) != 1) + 1)
        win = np.concatenate([read_window(band, int(p[0]), r0, len(p), h) for p in runs], axis=1)
    win = win.astype(np.float32)
    valid = (win != src['nodata']).astype(np.float32) if src['nodata'] is not None else np.ones_like(win)
    cc = np.clip(cols - c0, 0, win.shape[1] - 1.000001)
    rr = np.clip(rows - r0, 0, win.shape[0] - 1.000001)
    ci, ri = np.floor(cc).astype(int), np.floor(rr).astype(int)
    ci1, ri1 = np.minimum(ci + 1, win.shape[1] - 1), np.minimum(ri + 1, win.shape[0] - 1)
    fc, fr = cc - ci, rr - ri
    wts = [((1 - fc) * (1 - fr), ri, ci), (fc * (1 - fr), ri, ci1), ((1 - fc) * fr, ri1, ci), (fc * fr, ri1, ci1)]
    num = sum(w * win[a, b] * valid[a, b] for w, a, b in wts)
    den = sum(w * valid[a, b] for w, a, b in wts)
    den = np.where(ok, den, 0)
    num, den = num.reshape(shape), den.reshape(shape)
    alpha = den.mean(axis=-1)
    value = np.where(alpha > 0, num.sum(axis=-1) / np.maximum(den.sum(axis=-1), 1e-12), 0)
    return value, alpha


def nac_tile(path, face, L, x, y, T, g, ss):
    value, alpha = raster_tile(path, face, L, x, y, T, g, ss)
    out = np.zeros(value.shape + (2,), np.uint8)
    out[..., 0] = np.clip(np.round(value), 0, 255)
    out[..., 1] = np.clip(np.round(alpha * 255), 0, 255)
    return out


def composite_tile(base, detail, face, L, x, y, T, g, ss):
    """Detail over base (alpha-weighted), opaque grey: wherever the detail has no data
    (outside its footprint, or its own nodata gaps) the base shows through."""
    value, _ = raster_tile(base, face, L, x, y, T, g, ss)
    if nac_intersects(face, L, x, y):
        dv, da = raster_tile(detail, face, L, x, y, T, g, ss)
        value = da * dv + (1 - da) * value
    return np.clip(np.round(value), 0, 255).astype(np.uint8)[..., None]


def nac_intersects(face, L, x, y):
    """Tiles that can hold mosaic pixels: within 9° of the south pole (the mosaic square reaches 81.5°S)."""
    c, rad = tile_extent(face, L, x, y)
    return math.acos(min(1.0, float(-c[2]))) - rad < math.radians(9.0)


# ---------------------------------------------------------------------------
# Writers


def write_image(path, img):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    h, w, bands = img.shape
    mem = gdal.GetDriverByName('MEM').Create('', w, h, bands, gdal.GDT_Byte)
    for b in range(bands):
        mem.GetRasterBand(b + 1).WriteArray(img[..., b])
    jpeg = path.endswith('.jpg')
    gdal.GetDriverByName('JPEG' if jpeg else 'PNG').CreateCopy(path, mem, options=[f'QUALITY={JPEG_QUALITY}'] if jpeg else ['ZLEVEL=9'])
    aux = path + '.aux.xml'
    if os.path.exists(aux):
        os.remove(aux)


_JOB = {}


def _init_job(job):
    _JOB.update(job)


def tile_job(key):
    face, L, x, y = key
    J = _JOB
    T, g, ss = J['tile_size'], J['gutter'], J['ss']
    if J['kind'] == 'grid':
        U, V = pixel_samples(L, x, y, T, g, ss)
        texel_deg = math.degrees(2.0 / 2 ** L / T)  # face-centre texel (the largest)
        rgb = grid_pattern(directions(face, U, V), texel_deg).mean(axis=2)
        img = np.clip(np.round(rgb * 255), 0, 255).astype(np.uint8)
    elif J['kind'] == 'registration':
        img = registration_pattern(face, L, x, y, T, g)
    elif J['kind'] == 'xyz':
        from cube_xyz import tile
        img = tile(J['source'], face, L, x, y, T, g, ss)
    elif J['kind'] == 'composite':
        img = composite_tile(J['base'], J['detail'], face, L, x, y, T, g, ss)
    else:
        img = nac_tile(J['source'], face, L, x, y, T, g, ss)
    path = os.path.join(J['out'], 'tiles', face, str(L), str(x), f"{y}.{J['ext']}")
    write_image(path, img)
    return key, os.path.getsize(path), hashlib.sha256(open(path, 'rb').read()).hexdigest(), (int(img[..., -1].max()) if J['kind'] in ('nac', 'xyz') else 255)


def marker_table(tiles, T, g):
    """Expected tile and pixel of every marker centre at each level that holds it."""
    have = set(tiles)
    rows = []
    for name, la, lo, colour in MARKERS:
        d = unit(la, lo)
        # Face and coordinate by CubeSphere.ts ownership (X > Y > Z on exact ties).
        a = np.abs(d)
        if a[0] >= a[1] and a[0] >= a[2]:
            face = 'px' if d[0] >= 0 else 'nx'
        elif a[1] >= a[2]:
            face = 'py' if d[1] >= 0 else 'ny'
        else:
            face = 'pz' if d[2] >= 0 else 'nz'
        n_, a_, b_ = (np.array(e, np.float64) for e in CUBE_BASES[face])
        s = d @ n_
        u, v = float(d @ a_ / s), float(d @ b_ / s)
        levels = []
        for L in range(31):
            cnt = 2 ** L
            x, y = min(cnt - 1, int(math.floor((u + 1) / 2 * cnt))), min(cnt - 1, int(math.floor((v + 1) / 2 * cnt)))
            if (face, L, x, y) not in have:
                continue
            u0, v0, size = tile_rect(L, x, y)
            levels.append({'level': L, 'tile': f'{face}/{L}/{x}/{y}',
                           'column': g + (u - u0) / size * T, 'row': g + (v0 + size - v) / size * T})
        rows.append({'name': name, 'latDeg': la, 'lonDeg': lo, 'direction': d.tolist(), 'face': face, 'u': u, 'v': v,
                     'centreColour': list(colour), 'centreRadiusKm': RING_KM[-1] * 0.5, 'annuliKm': ANNULI_KM,
                     'rings': RING_KM, 'levels': levels})
    return rows


def run(args, kind, tiles, source_meta, registration, colour_space, extra=None):
    t0 = time.time()
    os.makedirs(args.out, exist_ok=True)
    ext = 'jpg' if kind == 'composite' else 'png'  # opaque grey: JPEG is a third of the bytes
    _JOB.update(kind=kind, tile_size=args.tile_size, gutter=args.gutter, ss=args.supersample, out=args.out, ext=ext,
                source=getattr(args, 'source', None), base=getattr(args, 'base', None), detail=getattr(args, 'detail', None))
    print(f'{len(tiles):,} tiles, levels {tiles[0][1]}–{max(k[1] for k in tiles)}, on {args.workers} workers', flush=True)
    sizes, hashes, empty = {}, {}, set()
    # spawn, not fork: a worker forked after GDAL/curl has opened connections (raster_open below)
    # can die on macOS, and a Pool whose worker dies mid-task waits forever.
    with mp.get_context('spawn').Pool(args.workers, initializer=_init_job, initargs=(dict(_JOB),)) as pool:
        for k, (key, nbytes, content_hash, alpha) in enumerate(pool.imap_unordered(tile_job, tiles, chunksize=4)):
            sizes[key] = nbytes
            hashes[key] = content_hash
            if alpha == 0:
                empty.add(key)
            if k % 200 == 0:
                print(f'  {k:,}/{len(tiles):,} ({time.time() - t0:.0f}s)', flush=True)
    if kind == 'xyz':
        from pathlib import Path
        config = json.load(open(args.source))
        prefix = config['url'].split('{z}')[0]
        receipts = [json.load(open(path)) for path in Path(config['cache']).glob('*/*.fallback.json')]
        extra = {**(extra or {}), 'sourceFallbacks': [r for r in receipts if r['url'].startswith(prefix)]}
    # Drop fully transparent subtrees below the root level (ancestors already draw
    # nothing there); a transparent tile with a non-empty descendant stays, so the tree is complete.
    keep_set = set()
    for k in sorted(tiles, key=lambda k: -k[1]):
        f, L, x, y = k
        kids = [(f, L + 1, 2 * x + dx, 2 * y + dy) for dy in (0, 1) for dx in (0, 1)]
        if L == 0 or k not in empty or any(c in keep_set for c in kids):
            keep_set.add(k)
        else:
            os.remove(os.path.join(args.out, 'tiles', f, str(L), str(x), f'{y}.{ext}'))
    keep = [k for k in tiles if k in keep_set]
    gen = hashlib.sha256(open(os.path.abspath(__file__), 'rb').read()).hexdigest()
    params = json.dumps({'kind': kind, 'tiles': len(keep), 'T': args.tile_size, 'g': args.gutter, 'ss': args.supersample,
                         'regions': args.region, 'global': args.global_level, 'radiusKm': R_KM,
                         'body': getattr(args, 'body', 'Moon'), 'registration': registration, 'contentHashes': [hashes[k] for k in keep], **(extra or {})}, sort_keys=True)
    version = f'cube-imagery-{kind}-' + hashlib.sha256((gen + params).encode()).hexdigest()[:16]
    manifest = {
        'format': 'cosmolabe-cube-imagery-1',
        'source': {**source_meta, 'version': version},
        'bodyId': getattr(args, 'body', 'Moon'),
        'metricRadiusKm': R_KM,
        'registration': registration,
        'tileSize': args.tile_size, 'gutter': args.gutter, 'encoding': 'jpeg' if ext == 'jpg' else 'png', 'colorSpace': colour_space,
        'minLevel': 0, 'maxLevel': max(k[1] for k in keep),
        'uri': 'tiles/{face}/{level}/{x}/{y}.' + ext,
        'sourceFallbacks': (extra or {}).get('sourceFallbacks', []),
        'generator': {'script': 'scripts/terrain/cube_imagery.py', 'sha256': gen, 'command': ' '.join(sys.argv[1:]),
                      'supersample': args.supersample, 'seconds': round(time.time() - t0, 1)},
        'bytes': sum(sizes[k] for k in keep),
        'tiles': [f'{f}/{L}/{x}/{y}' for f, L, x, y in keep],
    }
    json.dump(manifest, open(os.path.join(args.out, 'imagery.json'), 'w'), indent=1)
    print(f'wrote {len(keep):,} tiles, {manifest["bytes"] / 1e6:.1f} MB, in {time.time() - t0:.0f}s → {args.out}/imagery.json')
    return keep


def cmd_fixture(args):
    global R_KM
    R_KM = args.radius_km
    if not math.isfinite(R_KM) or R_KM <= 0:
        raise SystemExit('--radius-km must be positive and finite')
    regions = [parse_cube_region(r) for r in args.region or []]
    tiles = select_tiles(args.global_level, regions)
    meta = {'id': f'cube-imagery-fixture-{args.pattern}', 'kind': 'imagery',
            'attribution': 'Synthetic diagnostic fixture (scripts/terrain/cube_imagery.py); no observational data'}
    registration = {'crsId': f'cosmolabe:cube-gnomonic-1/{args.frame or "IAU_" + args.body.upper()}', 'pixelConvention': 'corner', 'registrationErrorKm': 0,
                    'latitude': 'planetocentric',
                    'resampling': f'analytic, {args.supersample}×{args.supersample} box per pixel' if args.pattern == 'grid' else 'exact texel index',
                    'footprint': 'global'}
    keep = run(args, args.pattern, tiles, meta, registration, 'srgb' if args.pattern == 'grid' else 'linear')
    if args.pattern == 'grid':
        json.dump({'convention': 'pixel corners at integers; column from the left (face u), row from the top (face v decreasing); centre colour sRGB bytes',
                   'tileSize': args.tile_size, 'gutter': args.gutter, 'markers': marker_table(keep, args.tile_size, args.gutter)},
                  open(os.path.join(args.out, 'markers.json'), 'w'), indent=1)


def cmd_xyz(args):
    """Preprocess each service independently; no mandatory baked source composite."""
    from cube_xyz import validate
    global R_KM
    R_KM = args.radius_km
    if not math.isfinite(R_KM) or R_KM <= 0:
        raise SystemExit('--radius-km must be positive and finite')
    source = validate(json.load(open(args.source)))
    if not source.get('cache'):
        raise SystemExit('source JSON requires cache (disk directory for original responses)')
    regions = [parse_cube_region(r) for r in args.region or []]
    tiles = select_tiles(args.global_level, regions)
    meta = {'id': source.get('id', source['url']), 'kind': 'imagery', 'url': source['url'],
            'attribution': source.get('attribution', '')}
    registration = {'crsId': f'cosmolabe:cube-gnomonic-1/{args.frame}', 'pixelConvention': 'corner',
                    'registrationErrorKm': None, 'latitude': 'planetocentric',
                    'resampling': f'XYZ EPSG:4326 bilinear premultiplied alpha; {args.supersample}x box samples per output pixel',
                    'footprint': f'finite built pyramid; source bounds {source.get("bounds", "global")}; source levels {source.get("minZoom", 0)}-{source.get("levels", 8)-1}; native detail only in declared built regions'}
    identity_config = {k: v for k, v in source.items() if k != 'cache'}
    if 'lockedTiles' in identity_config:
        # Local response bindings are not source identities. Content pins survive
        # relocation to a different worker/cache directory.
        identity_config['lockedTiles'] = {key: {'sha256': entry['sha256']} for key, entry in source['lockedTiles'].items()}
    run(args, 'xyz', tiles, meta, registration, 'srgb', extra={'sourceConfig': identity_config,
         'adapterSha256': hashlib.sha256(open(os.path.join(os.path.dirname(__file__), 'cube_xyz.py'), 'rb').read()).hexdigest()})


def cmd_nac(args):
    regions = [parse_cube_region(r) for r in args.region or []]
    tiles = select_tiles(args.global_level, regions, keep=nac_intersects)
    raster_open(args.source)  # fail early on CRS/network problems
    meta = {'id': 'lroc-nac-south-pole-controlled-mosaic-1m (scripts/terrain/cube_imagery.py nac)', 'kind': 'imagery',
            'attribution': 'LRO LROC NAC South Pole controlled mosaic, 1 m (USGS control network, LROC team mosaic; released Nov 2025; '
                           'PDS LRO-L-LROC-5-RDR-V1.0, doi:10.17189/1520341)',
            'url': args.source}
    registration = {'crsId': 'cosmolabe:cube-gnomonic-1/IAU_MOON', 'pixelConvention': 'corner',
                    'registrationErrorKm': None,
                    'resampling': f'bilinear from the overview ≤ 0.4 output-sample spacing, {args.supersample}×{args.supersample} box per pixel; nodata 0 → alpha',
                    'footprint': 'LROC NAC South Pole mosaic square (±182.107 km polar stereographic, reaching 81.5°S); transparent elsewhere'}
    run(args, 'nac', tiles, meta, registration, 'srgb', extra={'source': args.source})


def cmd_composite(args):
    regions = [parse_cube_region(r) for r in args.region or []]
    # Every face to --global-level from the base; deeper only where the detail can have pixels.
    tiles = select_tiles(args.global_level, regions, keep=lambda f, L, x, y: L <= args.global_level or nac_intersects(f, L, x, y))
    raster_open(args.base), raster_open(args.detail)  # fail early on CRS/network problems
    meta = {'id': 'lroc-wac-global-100m+lroc-nac-south-pole-1m (scripts/terrain/cube_imagery.py composite)', 'kind': 'imagery',
            'attribution': 'LRO LROC WAC global mosaic, 100 m (June 2013; LROC team, USGS Astrogeology); '
                           'LRO LROC NAC South Pole controlled mosaic, 1 m (USGS control network, LROC team mosaic; released Nov 2025; '
                           'PDS LRO-L-LROC-5-RDR-V1.0, doi:10.17189/1520341)',
            'base': os.path.basename(args.base), 'detail': args.detail}
    registration = {'crsId': 'cosmolabe:cube-gnomonic-1/IAU_MOON', 'pixelConvention': 'corner', 'registrationErrorKm': None,
                    'resampling': f'each source bilinear from its overview ≤ 0.4 output-sample spacing, {args.supersample}×{args.supersample} box per pixel; '
                                  'detail composited over base by its coverage (nodata 0 → base)',
                    'footprint': f'global (base, levels 0–{args.global_level}); detail inside the LROC NAC South Pole mosaic square (±182.107 km polar stereographic, reaching 81.5°S)'}
    run(args, 'composite', tiles, meta, registration, 'srgb',
        extra={'base': os.path.basename(args.base), 'detail': os.path.basename(args.detail), 'jpegQuality': JPEG_QUALITY})


def cmd_coregister(args):
    """Detail vs base registration and brightness: phase correlation of the two sources
    resampled onto the same cube tiles (no compositing), at sites inside the detail footprint."""
    import random
    rng = random.Random(args.seed)
    rows = []
    for k in range(args.samples):
        lat, lon = -84.5 - 3.5 * rng.random(), 360 * rng.random() - 180  # inside the NAC square, away from the pole
        d = unit(lat, lon)
        face = 'nz'
        n_, a_, b_ = (np.array(e, np.float64) for e in CUBE_BASES[face])
        u, v = float(d @ a_ / (d @ n_)), float(d @ b_ / (d @ n_))
        L = args.level
        x, y = int((u + 1) / 2 * 2 ** L), int((v + 1) / 2 * 2 ** L)
        T, g = args.tile_size, 0
        b, _ = raster_tile(args.base, face, L, x, y, T, g, 2)
        dv, da = raster_tile(args.detail, face, L, x, y, T, g, 2)
        if da.min() < 0.999 or b.std() < 1 or dv.std() < 1:
            continue  # partial NAC coverage, or featureless shadow
        A, B = (z - z.mean() for z in (b, dv))
        R = np.fft.fft2(A) * np.conj(np.fft.fft2(B))
        c = np.fft.ifft2(R / np.maximum(np.abs(R), 1e-9)).real
        j, i = np.unravel_index(np.argmax(c), c.shape)
        dy, dx = (j + T // 2) % T - T // 2, (i + T // 2) % T - T // 2
        texel_m = 2.0 / 2 ** L / T * R_KM * 1000 / (1 + u * u + v * v)  # along-face texel size here
        corr = float(np.corrcoef(b.ravel(), dv.ravel())[0, 1])
        rows.append({'latDeg': round(lat, 3), 'lonDeg': round(lon, 3), 'tile': f'{face}/{L}/{x}/{y}', 'shiftTexels': [int(dx), int(dy)],
                     'shiftM': round(math.hypot(dx, dy) * texel_m, 1), 'peak': round(float(c.max()), 3), 'corr': round(corr, 3),
                     'meanBase': round(float(b.mean()), 1), 'meanDetail': round(float(dv.mean()), 1)})
        print(rows[-1], flush=True)
    sh = sorted(r['shiftM'] for r in rows)
    out = {'base': os.path.basename(args.base), 'detail': args.detail, 'level': args.level, 'tileSize': args.tile_size, 'sites': len(rows),
           'shiftM': {'median': sh[len(sh) // 2], 'p90': sh[int(len(sh) * 0.9)], 'max': sh[-1]} if sh else None,
           'meanBrightness': {'base': round(float(np.mean([r['meanBase'] for r in rows])), 1), 'detail': round(float(np.mean([r['meanDetail'] for r in rows])), 1)},
           'rows': rows}
    print(json.dumps({k: v for k, v in out.items() if k != 'rows'}))
    if args.out:
        json.dump(out, open(args.out, 'w'), indent=1)


def cmd_selftest(args):
    """Synthetic rasters in /vsimem: a global equirectangular base whose value encodes longitude,
    and a detail covering only lon > 0 (nodata elsewhere). Checks the antimeridian unwrap, the
    window cap near a pole, and that the composite keeps the base wherever the detail has no data."""
    W, H = 720, 360
    srs = osr.SpatialReference()
    srs.SetFromUserInput(f'+proj=eqc +R={R_KM * 1000} +units=m +no_defs')
    half = math.pi * R_KM * 1000

    def make(path, fill):
        ds = gdal.GetDriverByName('GTiff').Create(path, W, H, 1, gdal.GDT_Byte, options=['TILED=YES'])
        ds.SetProjection(srs.ExportToWkt())
        ds.SetGeoTransform((-half, 2 * half / W, 0, half / 2, 0, -half / W))
        b = ds.GetRasterBand(1)
        b.SetNoDataValue(0)
        lon = (np.arange(W) + 0.5) / W * 360 - 180
        b.WriteArray(np.repeat(fill(lon)[None, :], H, 0).astype(np.uint8))
        ds.BuildOverviews('AVERAGE', [2, 4])
        ds = None
    base, detail = '/vsimem/base.tif', '/vsimem/detail.tif'
    make(base, lambda lon: 100 + np.round(np.abs(lon) / 4))           # 100 at lon 0 … 145 at ±180, continuous across ±180
    make(detail, lambda lon: np.where(lon > 0, 250, 0))                 # nodata west of the prime meridian
    T, g = 32, 4
    # nx face (lon ±180 at its centre, v along +Y): its level-1 tiles y = 0 and 1 meet on the
    # antimeridian, and each one's gutter reads across it.
    for y in (0, 1):
        v, a = raster_tile(base, 'nx', 1, 0, y, T, g, 2)
        assert a.min() > 0.99, 'antimeridian tile lost coverage'
        assert abs(v[g:-g, g:-g].max() - 145) <= 1.5 and v[g:-g, g:-g].min() > 120, f'antimeridian tile read the wrong side: {v.min()}..{v.max()}'
    # The unwrap keeps an antimeridian window narrow, so the full-resolution level stays in use.
    # Alternating 50/200 columns survive only at level 0; read globe-wide, the window would pass
    # the cap and fall to an averaged overview (uniform 125).
    global WINDOW_CAP
    make('/vsimem/stripes.tif', lambda lon: np.where(np.arange(W) % 2, 200, 50))
    cap, WINDOW_CAP = WINDOW_CAP, 2000
    try:
        v, _ = raster_tile('/vsimem/stripes.tif', 'nx', 4, 7, 8, T, g, 1)
    finally:
        WINDOW_CAP = cap
    assert v.std() > 40, f'antimeridian tile read a coarse overview (std {v.std():.1f})'
    # Exact pole: the window spans every longitude and stays capped (no error, full coverage).
    v, a = raster_tile(base, 'nz', 3, 3, 3, T, g, 2)
    assert a.min() > 0.99
    # Composite on the px face (lon 0 at its centre; v along +Y, so the top rows are east): east half detail, west half base.
    nac_intersects_orig = globals()['nac_intersects']
    globals()['nac_intersects'] = lambda *k: True
    try:
        img = composite_tile(base, detail, 'px', 0, 0, 0, T, g, 2)[..., 0].astype(float)
    finally:
        globals()['nac_intersects'] = nac_intersects_orig
    n = T + 2 * g
    east, west = img[int(n * 0.25), :], img[int(n * 0.75), :]
    assert np.all(east == 250), f'detail not drawn east: {east.min()}..{east.max()}'
    assert np.all((west > 100) & (west < 130)), f'base not kept west: {west.min()}..{west.max()}'
    print('cube_imagery selftest ok')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    for name in ('fixture', 'nac', 'composite', 'xyz'):
        s = sub.add_parser(name)
        s.add_argument('--out', required=True)
        s.add_argument('--global-level', type=int, default=3 if name == 'fixture' else 0)
        s.add_argument('--region', action='append', help='NAME@LAT,LON:L=KM[,L=KM…] (dem.py cube-tile syntax)')
        s.add_argument('--tile-size', type=int, default=256)
        s.add_argument('--gutter', type=int, default=4)
        s.add_argument('--supersample', type=int, default=3)
        s.add_argument('--workers', type=int, default=os.cpu_count())
    sub.choices['fixture'].add_argument('--pattern', choices=('grid', 'registration'), required=True)
    sub.choices['fixture'].add_argument('--radius-km', type=float, default=1737.4, help='angular-to-distance metric for diagnostic rings and region selection')
    sub.choices['fixture'].add_argument('--body', default='Moon')
    sub.choices['fixture'].add_argument('--frame')
    sub.choices['nac'].add_argument('--source', required=True)
    sub.choices['xyz'].add_argument('--source', required=True, help='XYZ source JSON; explicit latitudeConvention and disk cache required')
    sub.choices['xyz'].add_argument('--radius-km', type=float, required=True)
    sub.choices['xyz'].add_argument('--body', required=True)
    sub.choices['xyz'].add_argument('--frame', required=True)
    sub.choices['composite'].add_argument('--base', required=True, help='global raster (LROC WAC), drawn everywhere')
    sub.choices['composite'].add_argument('--detail', required=True, help='regional raster (LROC NAC South Pole) drawn over it where it has data')
    c = sub.add_parser('coregister')
    c.add_argument('--base', required=True)
    c.add_argument('--detail', required=True)
    c.add_argument('--level', type=int, default=8)
    c.add_argument('--tile-size', type=int, default=256)
    c.add_argument('--samples', type=int, default=40)
    c.add_argument('--seed', type=int, default=1)
    c.add_argument('--out')
    sub.add_parser('selftest')
    args = p.parse_args()
    {'fixture': cmd_fixture, 'xyz': cmd_xyz, 'nac': cmd_nac, 'composite': cmd_composite, 'coregister': cmd_coregister, 'selftest': cmd_selftest}[args.cmd](args)


if __name__ == '__main__':
    main()
