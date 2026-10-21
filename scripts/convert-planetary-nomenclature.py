#!/usr/bin/env python3
"""Bounded offline KML/KMZ point-placemark -> planetary GeoJSON catalog converter.

This intentionally does not claim that a KML point describes a feature boundary,
terrain height, or a precisely surveyed location. Only one Point per Placemark
is supported. The resulting catalog uses the existing geographicLayers contract.
No network access, dependencies, or ingestion service is needed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile

MAX_ARCHIVE_BYTES = 32 * 1024 * 1024
MAX_XML_BYTES = 16 * 1024 * 1024
MAX_ARCHIVE_FILES = 128
MAX_PLACEMARKS = 50_000
MAX_FIELDS = 64
MAX_FIELD_CHARS = 2048
# Leave headroom under the geographic loader's 2 MiB decoded/source budget.
MAX_GEOJSON_BYTES = 1_800_000
MAX_CATALOG_GEOJSON_BYTES = 7_500_000  # loader caps all sources in a catalog at 8 MiB
MAX_FEATURES_PER_FILE = 4_000


def local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1]


def children(el: ET.Element, tag: str) -> list[ET.Element]:
    return [c for c in el if local(c.tag) == tag]


def child_text(el: ET.Element, tag: str) -> str:
    for c in children(el, tag):
        return (c.text or '').strip()
    return ''


def input_kml(path: Path) -> bytes:
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError('Input exceeds the 32 MiB file limit')
    if path.suffix.lower() == '.kml':
        data = path.read_bytes()
    elif path.suffix.lower() == '.kmz':
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            if len(members) > MAX_ARCHIVE_FILES:
                raise ValueError('KMZ has too many archive entries')
            for info in members:
                name = PurePosixPath(info.filename.replace('\\', '/'))
                if name.is_absolute() or '..' in name.parts or info.filename.startswith('\\'):
                    raise ValueError('Unsafe KMZ member path')
                if (info.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ValueError('KMZ symlinks are unsupported')
                if info.file_size > MAX_XML_BYTES or (info.file_size > 0 and info.file_size > max(1, info.compress_size) * 150):
                    raise ValueError('Oversized or suspicious KMZ member')
            candidates = [i for i in members if not i.is_dir() and i.filename.lower().endswith('.kml')]
            if len(candidates) != 1:
                raise ValueError('KMZ must contain exactly one KML document')
            data = archive.read(candidates[0])
    else:
        raise ValueError('Expected .kml or .kmz input')
    if len(data) > MAX_XML_BYTES:
        raise ValueError('KML exceeds the 16 MiB XML limit')
    if re.search(rb'<!\s*(?:DOCTYPE|ENTITY)\b', data, flags=re.I):
        raise ValueError('DTD and entity declarations are not allowed in KML')
    return data


def source_fields(placemark: ET.Element) -> dict[str, str]:
    result: dict[str, str] = {}
    for node in placemark.iter():
        tag = local(node.tag)
        if tag not in ('SimpleData', 'Data'):
            continue
        name = node.attrib.get('name', '').strip()
        if not name or len(name) > 128 or len(result) >= MAX_FIELDS:
            continue
        value = child_text(node, 'value') if tag == 'Data' else (node.text or '').strip()
        if value:
            result[name] = value[:MAX_FIELD_CHARS]
    return result


def lookup(fields: dict[str, str], keys: tuple[str, ...]) -> str:
    by_name = {re.sub(r'[^a-z0-9]', '', k.lower()): v for k, v in fields.items()}
    for key in keys:
        value = by_name.get(re.sub(r'[^a-z0-9]', '', key.lower()), '').strip()
        if value:
            return value
    return ''


def point_position(pm: ET.Element, domain: str) -> list[float] | None:
    # MultiGeometry/LineString/Polygon are not reduced to invented centroids.
    geometries = [node for node in pm.iter() if local(node.tag) in ('Point', 'LineString', 'Polygon', 'MultiGeometry', 'Model', 'gx:Track')]
    if len(geometries) != 1 or local(geometries[0].tag) != 'Point':
        return None
    raw = child_text(geometries[0], 'coordinates').split()
    if len(raw) != 1:
        return None
    coords = raw[0].split(',')
    if len(coords) not in (2, 3):
        return None
    try:
        lon, lat = map(float, coords[:2])
    except ValueError:
        return None
    if not all(map(math.isfinite, (lon, lat))) or abs(lat) > 90:
        return None
    if (domain == '0..360' and not 0 <= lon <= 360) or (domain == '-180..180' and not -180 <= lon <= 180):
        return None
    # Keep declared source convention verbatim; the loader owns conversion.
    # Do not pass KML Z: it may represent zero, ellipsoid height, or another
    # altitude mode, and the geographic importer requires an explicit datum.
    return [lon, lat]


def to_features(xml: bytes, domain: str) -> tuple[list[dict], dict[str, int]]:
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ValueError(f'Invalid KML XML: {exc}') from exc
    if local(root.tag) != 'kml':
        raise ValueError('Expected a KML root element')
    placemarks = (node for node in root.iter() if local(node.tag) == 'Placemark')
    features: list[dict] = []
    skipped = {'unnamed': 0, 'non_point_or_invalid_coordinate': 0, 'duplicate': 0}
    seen: set[str] = set()
    for count, pm in enumerate(placemarks, 1):
        if count > MAX_PLACEMARKS:
            raise ValueError('KML exceeds the placemark limit')
        fields = source_fields(pm)
        name = (child_text(pm, 'name') or lookup(fields, ('Feature_Name', 'Feature Name', 'Name'))).strip()
        if not name:
            skipped['unnamed'] += 1
            continue
        if len(name) > 512:
            skipped['unnamed'] += 1
            continue
        coords = point_position(pm, domain)
        if coords is None:
            skipped['non_point_or_invalid_coordinate'] += 1
            continue
        kind = lookup(fields, ('Feature_Type', 'Feature Type', 'Type', 'FeatureClass'))
        official_id = lookup(fields, ('Feature_ID', 'Feature ID', 'Gazetteer_ID', 'Gazetteer ID', 'ID')) or pm.attrib.get('id', '').strip()
        fallback = hashlib.sha256(json.dumps([name, kind, coords], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()[:20]
        # Include a content key even with an official ID: identity is stable
        # across ordering, and a source typo cannot collapse two place records.
        place_id = f'gazetteer:{official_id}' if official_id and len(official_id) <= 128 else f'gazetteer:anchor:{fallback}'
        if place_id in seen:
            skipped['duplicate'] += 1
            continue
        seen.add(place_id)
        props = {
            'name': name, 'placeKind': 'nomenclature',
            'coordinateRole': 'source-placemark-anchor',
            'sourceFields': fields,
        }
        if kind:
            props['featureClass'] = kind
        features.append({'type': 'Feature', 'id': place_id, 'properties': props, 'geometry': {'type': 'Point', 'coordinates': coords}})
    return features, skipped


def serialized(features: list[dict]) -> bytes:
    return (json.dumps({'type': 'FeatureCollection', 'features': features}, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8')


def chunks(features: list[dict]) -> list[bytes]:
    # Compute incremental size in O(n). Re-serializing the entire accumulated
    # feature list on every iteration is quadratic for full-body gazetteers.
    groups: list[bytes] = []
    current: list[dict] = []
    size = len(serialized([]))
    empty = size
    total_bytes = 0
    for feature in features:
        feature_size = len(json.dumps(feature, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        candidate = size + (1 if current else 0) + feature_size
        if candidate > MAX_GEOJSON_BYTES or len(current) >= MAX_FEATURES_PER_FILE:
            if not current:
                raise ValueError(f'Feature {feature["id"]} exceeds the per-layer size budget')
            payload = serialized(current)
            groups.append(payload)
            total_bytes += len(payload)
            current = []
            size = empty
            candidate = size + feature_size
        if candidate > MAX_GEOJSON_BYTES:
            raise ValueError(f'Feature {feature["id"]} exceeds the per-layer size budget')
        current.append(feature)
        size = candidate
    if current:
        payload = serialized(current)
        groups.append(payload)
        total_bytes += len(payload)
    if len(groups) > 16 or total_bytes > MAX_CATALOG_GEOJSON_BYTES:
        raise ValueError('Nomenclature exceeds the viewer catalog budget (16 layers/8 MiB); split into separate body/region catalogs')
    return groups


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input', type=Path, help='Downloaded per-body point-placemark .kml or .kmz')
    p.add_argument('--output-catalog', type=Path, required=True, help='Write catalog descriptor and adjacent GeoJSON chunks here')
    p.add_argument('--body', required=True, help='Body name in the scene (for example Mars or Moon)')
    p.add_argument('--latitude', required=True, choices=['planetocentric', 'planetographic'])
    p.add_argument('--longitude-direction', required=True, choices=['east', 'west'])
    p.add_argument('--longitude-domain', required=True, choices=['0..360', '-180..180'])
    shape = p.add_mutually_exclusive_group(required=True)
    shape.add_argument('--sphere-radius-km', type=float)
    shape.add_argument('--ellipsoid-radii-km', type=float, nargs=3, metavar=('A', 'B', 'C'))
    p.add_argument('--layer-id', help='Stable dataset identity; default uses body and input filename')
    p.add_argument('--attribution', default='User-supplied KML/KMZ placemarks')
    p.add_argument('--source-url', default='', help='Download URL for provenance (not fetched)')
    return p


def convert(args: argparse.Namespace) -> dict:
    if not args.body.strip() or not args.attribution.strip():
        raise ValueError('Body and attribution cannot be empty')
    if args.sphere_radius_km is not None:
        r = args.sphere_radius_km
        if not math.isfinite(r) or r <= 0:
            raise ValueError('Radius must be positive and finite')
        shape = {'kind': 'sphere', 'radiusKm': r}
    else:
        a, b, c = args.ellipsoid_radii_km
        if not all(math.isfinite(v) and v > 0 for v in (a, b, c)) or a != b or c > a:
            raise ValueError('Only oblate ellipsoids [a,a,c] are supported by the current importer')
        shape = {'kind': 'ellipsoid', 'radiiKm': [a, b, c]}
    data = input_kml(args.input)
    features, skipped = to_features(data, args.longitude_domain)
    if not features:
        raise ValueError(f'No usable point placemarks; skipped={skipped}')
    parts = chunks(features)
    output = args.output_catalog
    prefix = args.layer_id or f'{args.body.lower()}:{args.input.stem.lower().replace(" ", "-")}'
    if not prefix.strip():
        raise ValueError('layer-id must not be empty')
    names = [f'{output.stem}-{i + 1:03}.geojson' for i in range(len(parts))]
    for name in names:
        if (output.parent / name).resolve() == output.resolve():
            raise ValueError('Output paths overlap')
    catalog = {
        'name': f'{args.body} nomenclature ({args.input.stem})',
        'geographicCoordinates': {
            'latitude': args.latitude, 'longitudeDirection': args.longitude_direction,
            'longitudeDomain': args.longitude_domain, 'referenceShape': shape,
        },
        'geographicLayers': [{
            'id': f'{prefix}:{i + 1:03}', 'name': f'{args.body} places ({i + 1}/{len(parts)})',
            'body': args.body, 'source': name, 'display': {'visible': False},
            'provenance': {
                'attribution': args.attribution, 'sourceUrl': args.source_url,
                'sourceFile': args.input.name, 'sourceSha256': hashlib.sha256(args.input.read_bytes()).hexdigest(),
                'converter': 'cosmolabe:191:v1', 'geometrySemantics': 'point-anchor-not-feature-boundary',
            },
        } for i, name in enumerate(names)],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    # Prepare everything before writing; don't overwrite a catalog with a bad archive.
    for name, data in zip(names, parts):
        (output.parent / name).write_bytes(data)
    output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'features': len(features), 'chunks': len(parts), 'skipped': skipped, 'catalog': str(output)}


def main() -> int:
    try:
        result = convert(parser().parse_args())
        print(json.dumps(result, indent=2))
        if sum(result['skipped'].values()):
            print('Warning: some KML placemarks were skipped; inspect skipped counts.', file=sys.stderr)
        return 0
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        print(f'nomenclature conversion failed: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())