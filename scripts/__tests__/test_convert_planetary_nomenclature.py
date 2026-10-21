"""Run with: python3 -m unittest discover -s scripts/__tests__ -p test_convert_planetary_nomenclature.py"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile
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
            first = data['features'][0]
            self.assertEqual(first['id'], 'gazetteer:jezero')
            self.assertEqual(first['properties']['name'], 'Jezero')
            self.assertEqual(first['properties']['featureClass'], 'Crater')
            self.assertEqual(first['properties']['sourceFields']['Diameter'], '49')
            self.assertEqual(first['geometry']['coordinates'], [77.45, 18.45])
            self.assertEqual(data['features'][1]['properties']['name'], 'Site Alpha')
            self.assertEqual(data['features'][1]['geometry']['coordinates'], [0, -89.5])

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
        self.assertEqual(skipped, {'unnamed': 1, 'non_point_or_invalid_coordinate': 1, 'duplicate': 0})

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