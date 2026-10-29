"""Run with: python3 -m unittest discover -s scripts/__tests__ -p test_convert_planetary_nomenclature.py"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from argparse import Namespace

SCRIPT = Path(__file__).resolve().parents[1] / 'convert-planetary-nomenclature.py'
spec = importlib.util.spec_from_file_location('nomenclature_converter', SCRIPT)
converter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(converter)

KML = b'''<?xml version="1.0" encoding="utf-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark id="jezero"><name>Jezero</name><ExtendedData><SchemaData>
<SimpleData name="Feature_Type">Crater</SimpleData>
<SimpleData name="Diameter">49</SimpleData>
</SchemaData></ExtendedData><Point><coordinates>77.45,18.45,0</coordinates></Point></Placemark>
<Placemark><ExtendedData><Data name="Name"><value>Site Alpha</value></Data></ExtendedData>
<Point><coordinates>0,-89.5</coordinates></Point></Placemark>
<Placemark><name>Unsupported boundary</name><Polygon><outerBoundaryIs/></Polygon></Placemark>
</Document></kml>'''


def options(input_path: Path, output_path: Path) -> Namespace:
    return Namespace(input=input_path, output_catalog=output_path, body='Mars',
                     latitude='planetocentric', longitude_direction='east', longitude_domain='0..360',
                     sphere_radius_km=None, ellipsoid_radii_km=[3396.19, 3396.19, 3376.2],
                     layer_id='mars:iau-places', attribution='USGS Gazetteer, as downloaded by catalog author',
                     source_url='https://planetarynames.wr.usgs.gov/')


class NomenclatureTests(unittest.TestCase):
    def test_kml_catalog_with_metadata_and_2d_points(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'mars.kml'
            source.write_bytes(KML)
            catalog_path = root / 'places.json'
            summary = converter.convert(options(source, catalog_path))
            self.assertEqual((summary['features'], summary['chunks']), (2, 1))
            self.assertEqual(summary['skipped']['non_point_or_invalid_coordinate'], 1)
            catalog = json.loads(catalog_path.read_text())
            self.assertEqual(catalog['geographicCoordinates']['latitude'], 'planetocentric')
            self.assertEqual(catalog['geographicCoordinates']['longitudeDirection'], 'east')
            layer = catalog['geographicLayers'][0]
            self.assertFalse(layer['display']['visible'])
            self.assertEqual(layer['id'], 'mars:iau-places:001')
            self.assertEqual(layer['provenance']['geometrySemantics'], 'point-anchor-not-feature-boundary')
            data = json.loads((root / layer['source']).read_text())
            self.assertEqual(len(data['features']), 2)
            first = next(f for f in data['features'] if f['id'] == 'gazetteer:jezero')
            self.assertEqual(first['id'], 'gazetteer:jezero')
            self.assertEqual(first['properties']['name'], 'Jezero')
            self.assertEqual(first['properties']['featureClass'], 'Crater')
            self.assertEqual(first['properties']['sourceFields']['Diameter'], '49')
            self.assertEqual(first['geometry']['coordinates'], [77.45, 18.45])
            second = next(f for f in data['features'] if f['properties']['name'] == 'Site Alpha')
            self.assertEqual(second['geometry']['coordinates'], [0, -89.5])

    def test_preserves_explicit_frame_without_inferring_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'moon.kml'
            source.write_bytes(KML)
            args = options(source, root / 'places.json')
            args.body = 'Moon'
            converter.convert(args)
            self.assertNotIn('frame', json.loads(args.output_catalog.read_text())['geographicCoordinates'])
            args.frame = 'MOON_ME_DE421'
            converter.convert(args)
            self.assertEqual(json.loads(args.output_catalog.read_text())['geographicCoordinates']['frame'], args.frame)

    def test_kmz_nested_doc_and_stable_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'mars.kmz'
            with zipfile.ZipFile(source, 'w', compression=zipfile.ZIP_DEFLATED) as z:
                z.writestr('images/icon.png', b'icon')
                z.writestr('folder/doc.kml', KML)
            data = converter.input_kml(source)
            first, skipped = converter.to_features(data, '0..360')
            second, _ = converter.to_features(data, '0..360')
            self.assertEqual(first, second)
            self.assertEqual(skipped['non_point_or_invalid_coordinate'], 1)
            result = converter.convert(options(source, root / 'places.json'))
            self.assertEqual(result['features'], 2)

    def test_explicit_domain_and_missing_name(self):
        kml = b'''<kml><Document><Placemark><name>Bad east domain</name><Point><coordinates>-10,0</coordinates></Point></Placemark><Placemark><Point><coordinates>10,0</coordinates></Point></Placemark><Placemark><name>Good</name><Point><coordinates>360,90,0</coordinates></Point></Placemark></Document></kml>'''
        good, skipped = converter.to_features(kml, '0..360')
        self.assertEqual(len(good), 1)
        self.assertEqual(good[0]['geometry']['coordinates'], [360, 90])
        self.assertEqual(skipped, {'unnamed': 1, 'non_point_or_invalid_coordinate': 0, 'duplicate': 0, 'longitude_domain_mismatch': 1})

    def test_encoded_declarations_rejected_at_parser_boundary(self):
        for encoding in ('utf-8', 'utf-16', 'utf-16-le', 'utf-16-be'):
            with self.subTest(encoding=encoding), tempfile.TemporaryDirectory() as tmp:
                xml = f'<?xml version="1.0" encoding="{encoding}"?><!DOCTYPE kml [<!ENTITY x "EXPANDED">]><kml><name>&x;</name></kml>'.encode(encoding)
                source = Path(tmp) / 'encoded.kml'
                source.write_bytes(xml)
                with self.assertRaises(ValueError):
                    converter.input_kml(source)
                with self.assertRaises(ValueError):
                    converter.to_features(xml, '-180..180')
        safe = '<?xml version="1.0" encoding="utf-16"?><kml/>'.encode('utf-16')
        self.assertEqual(converter.to_features(safe, '-180..180')[0], [])

    def test_actual_usgs_fields_signed_coordinates_and_durable_ids(self):
        for body, name, identity, coords in [('mars', 'Jezero', 'gazetteer:14300', [77.6873, 18.4082]),
                                             ('moon', 'Shackleton', 'gazetteer:5450', [129.78, -89.67])]:
            xml = (Path(__file__).parent / 'fixtures' / f'usgs-{body}.kml').read_bytes()
            features, skipped = converter.to_features(xml, '-180..180')
            self.assertEqual(sum(skipped.values()), 0)
            place = next(f for f in features if f['properties']['name'] == name)
            self.assertEqual(place['id'], identity)
            self.assertEqual(place['geometry']['coordinates'], coords)
            self.assertEqual(place['properties']['featureClass'], 'Crater, craters')
            self.assertTrue(any(f['geometry']['coordinates'][0] < 0 for f in features))
            # Source-generated Placemark row numbers do not own Gazetteer identity.
            import re
            reordered = re.sub(rb'id="[^"]+"', b'id="different-row"', xml)
            self.assertEqual(converter.to_features(reordered, '-180..180')[0], features)

    def test_domain_mismatch_fails_conspicuously_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(__file__).parent / 'fixtures' / 'usgs-mars.kml'
            output = Path(tmp) / 'places.json'
            with self.assertRaisesRegex(ValueError, 'Longitude domain mismatch'):
                converter.convert(options(source, output))
            self.assertFalse(output.exists())

    def test_source_output_collision_including_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / 'source.kml'
            source.write_bytes(KML)
            for output in (source, Path(tmp) / 'link.json'):
                if output != source:
                    output.symlink_to(source)
                with self.assertRaisesRegex(ValueError, 'overlap'):
                    converter.convert(options(source, output))
                self.assertEqual(source.read_bytes(), KML)

    def test_logical_place_references_survive_reordering_and_new_chunk_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(converter, 'MAX_FEATURES_PER_FILE', 1):
            source = Path(tmp) / 'source.kml'
            source.write_bytes(KML)
            output = Path(tmp) / 'out.json'
            def references():
                catalog = json.loads(output.read_text())
                return {f['properties']['name']: f['properties']['placeRef']
                        for layer in catalog['geographicLayers']
                        for f in json.loads((output.parent / layer['source']).read_text())['features']}
            converter.convert(options(source, output))
            before = references()
            source.write_bytes(KML.replace(b'<Document>', b'<Document><Placemark id="aaa"><name>New first row</name><Point><coordinates>1,2</coordinates></Point></Placemark>'))
            converter.convert(options(source, output))
            after = references()
            self.assertEqual(before, {k: after[k] for k in before})

    def test_rejects_ambiguous_and_hostile_archives(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            p = root / 'invalid.kmz'
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr('../doc.kml', KML)
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                converter.input_kml(p)
            with zipfile.ZipFile(p, 'w') as z:
                z.writestr('a.kml', KML)
                z.writestr('b.kml', KML)
            with self.assertRaisesRegex(ValueError, 'exactly one'):
                converter.input_kml(p)
            p = root / 'invalid.kml'
            p.write_bytes(b'<!DOCTYPE kml [<!ENTITY x "bad">]><kml/>')
            with self.assertRaisesRegex(ValueError, 'DTD'):
                converter.input_kml(p)

    def test_rejects_bad_shape_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'mars.kml'
            source.write_bytes(KML)
            args = options(source, root / 'out.json')
            args.ellipsoid_radii_km = [3396.19, 3390, 3376.2]
            with self.assertRaisesRegex(ValueError, 'oblate'):
                converter.convert(args)
            self.assertFalse(args.output_catalog.exists())

    def test_chunking_respects_existing_loader_caps(self):
        sample = {'type': 'Feature', 'id': 'f', 'properties': {'name': 'Feature'},
                  'geometry': {'type': 'Point', 'coordinates': [0, 0]}}
        parts = converter.chunks([{**sample, 'id': str(i)} for i in range(4_101)])
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(len(part) <= converter.MAX_GEOJSON_BYTES for part in parts))
        self.assertEqual(sum(len(json.loads(part)['features']) for part in parts), 4_101)


if __name__ == '__main__':
    unittest.main()
