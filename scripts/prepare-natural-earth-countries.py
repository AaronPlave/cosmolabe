#!/usr/bin/env python3
"""Convert the pinned official shapefile with pyshp==2.3.1; no simplification.
Usage: python scripts/prepare-natural-earth-countries.py /path/to/download.zip
"""
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile
import shapefile

EXPECTED = '0f243aeac8ac6cf26f0417285b0bd33ac47f1b5bdb719fd3e0df37d03ea37110'
raw = Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(raw).hexdigest() == EXPECTED, 'Unexpected source archive; review version changes explicitly'
assert shapefile.__version__ == '2.3.1', 'Use pyshp==2.3.1'
archive = zipfile.ZipFile(io.BytesIO(raw))
stem = 'ne_110m_admin_0_countries'
reader = shapefile.Reader(**{ext: io.BytesIO(archive.read(f'{stem}.{ext}')) for ext in ['shp', 'shx', 'dbf']})
changes = []

def normalize_ring(ring, identity):
    # Shapefile seam coordinates differ by a few ulps on either side of 180.
    # Canonicalize only that representational noise, not ordinary coordinates.
    points = []
    for lon, lat in ring:
        if abs(abs(lon) - 180) < 1e-10:
            lon = -180.0
        points.append([lon, lat])
    # A planar polar cap closes along both sides of the map cut, via the pole.
    # On the globe this is a zero-area spike: A, pole, pole, A. Remove that
    # artificial closure, retaining every actual coastline vertex. The resulting
    # winding ring uses the renderer's existing polar chart.
    for i in range(len(points) - 3):
        if (points[i] == points[i + 3] and abs(points[i][0]) == 180
                and abs(points[i + 1][1]) == 90 and points[i + 1] == points[i + 2]):
            changes.append({'feature': identity, 'operation': 'remove zero-area map-cut closure', 'vertices': ring[i:i + 4]})
            return points[:i] + points[i + 3:]
    return points

features = []
for record in reader.iterShapeRecords():
    properties = record.record.as_dict()
    geometry = record.shape.__geo_interface__
    polygons = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
    polygons = [[normalize_ring(r, properties['NAME']) for r in p] for p in polygons]
    geometry['coordinates'] = polygons if geometry['type'] == 'MultiPolygon' else polygons[0]
    features.append({'type': 'Feature', 'id': str(properties['NE_ID']),
                     'properties': {k: properties[k] for k in ['NE_ID', 'ADMIN', 'NAME', 'ADM0_A3', 'ISO_A3']}, 'geometry': geometry})
root = Path(__file__).resolve().parents[1]
target = root / 'apps/viewer/test-catalogs/geographic/natural-earth-countries.json'
target.write_text(json.dumps({'type': 'FeatureCollection', 'features': features}, separators=(',', ':')) + '\n')
print(json.dumps({'features': len(features), 'bytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'changes': changes}, indent=2))
