"""Network-free adapter registration, alpha, wrapping and source-grid regressions."""
import sys
sys.dont_write_bytecode = True
import unittest
import io
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from osgeo import gdal
import numpy as np
from cube_xyz import sample, source_pixel, validate, in_bounds, read_tile


class CubeXYZTests(unittest.TestCase):
    def test_pinned_response_replay_refuses_changed_bytes_without_publishing_manifest(self):
        import gzip
        import hashlib
        from acquire_cube_xyz import replay
        original=b'original response bytes'
        digest=hashlib.sha256(original).hexdigest()
        manifest=json.dumps({'version':2,'kind':'locked-xyz-bundle',
            'config':{'url':'https://example/{z}/{x}/{y}','dimension':2,'levels':1,'latitudeConvention':'planetocentric'},
            'tiles':{'0/0/0':{'path':'responses/'+digest+'.image','sha256':digest}}}).encode()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);pin=root/'inventory.json.gz';pin.write_bytes(gzip.compress(manifest,mtime=0))
            with patch('acquire_cube_xyz.urlopen',lambda *args,**kwargs:io.BytesIO(original)):
                replay(pin,root/'good',2)
            self.assertEqual((root/'good/bundle.json').read_bytes(),manifest)
            self.assertEqual((root/'good/responses'/f'{digest}.image').read_bytes(),original)
            with patch('acquire_cube_xyz.urlopen',lambda *args,**kwargs:io.BytesIO(b'new response')):
                with self.assertRaisesRegex(ValueError,'Original response changed'):
                    replay(pin,root/'bad',2)
            self.assertFalse((root/'bad/bundle.json').exists())

    def test_bundle_staging_rejects_a_falsely_claimed_source_hole(self):
        import hashlib
        sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'surface-build'))
        from worker import bundle
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);stage=root/'stage';stage.mkdir()
            raster=gdal.GetDriverByName('MEM').Create('',2,2,1,gdal.GDT_Byte);raster.GetRasterBand(1).Fill(37)
            source=root/'original.png';gdal.GetDriverByName('PNG').CreateCopy(str(source),raster)
            entry={'path':source.name,'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),
                   'unavailable':{'reason':'decode-failure','httpStatus':200,'url':'https://example/0/0/0'}}
            manifest=root/'bundle.json'
            def write():
                manifest.write_text(json.dumps({'version':2,'kind':'locked-xyz-bundle',
                  'config':{'url':'https://example/{z}/{x}/{y}','dimension':2,'levels':1,'latitudeConvention':'planetocentric'},'tiles':{'0/0/0':entry}}))
            write()
            with self.assertRaisesRegex(AssertionError,'is decodable'):
                bundle(manifest,stage/'config.json',root)
            source.write_bytes(b'truncated original response');entry['sha256']=hashlib.sha256(source.read_bytes()).hexdigest();write()
            receipt=bundle(manifest,stage/'config.json',root)
            self.assertEqual(len(receipt['unavailableResponses']),1)
            self.assertEqual(receipt['responseBytes'],len(source.read_bytes()))

    def test_pinned_unavailable_response_stays_transparent_without_network_or_parent(self):
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'bad.image';path.write_bytes(b'original truncated upstream response')
            entry = {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                     'unavailable':{'reason':'decode-failure','url':'https://example/1/1/1','httpStatus':200}}
            config = {'dimension':2,'lockedTiles':{'1/1/1':entry}}
            with patch('cube_xyz.urllib.request.urlopen',side_effect=AssertionError('network forbidden')):
                self.assertIsNone(read_tile(config,folder,1,1,1))
                rgb,alpha=sample(config,np.array([0.]),np.array([-1.]),1,folder,
                                 read=lambda *args:None)
                self.assertEqual(float(alpha[0]),0)
                np.testing.assert_array_equal(rgb,0)
                path.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError,'checksum mismatch'):
                    read_tile(config,folder,1,1,1)

    def test_locked_bundle_cannot_fetch_or_reuse_changed_bytes(self):
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'response.png'
            ds = gdal.GetDriverByName('MEM').Create('', 2, 2, 4, gdal.GDT_Byte)
            for i, value in enumerate([37, 81, 122, 255]):
                ds.GetRasterBand(i + 1).Fill(value)
            gdal.GetDriverByName('PNG').CreateCopy(str(path), ds)
            config = {'dimension': 2, 'lockedTiles': {'0/0/0': {'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}}}
            with patch('cube_xyz.urllib.request.urlopen', side_effect=AssertionError('network forbidden')):
                self.assertEqual(read_tile(config, folder, 0, 0, 0)[0, 0, 0], 37)
                with self.assertRaisesRegex(ValueError, 'missing required tile'):
                    read_tile(config, folder, 0, 1, 0)
                path.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    read_tile(config, folder, 0, 0, 0)

    def test_corrupt_source_uses_recorded_parent_fallback_only_when_enabled(self):
        with tempfile.TemporaryDirectory() as folder:
            path = str(Path(folder) / 'parent.png')
            raster = gdal.GetDriverByName('MEM').Create('', 2, 2, 4, gdal.GDT_Byte)
            for i, value in enumerate([37, 81, 122, 255]):
                raster.GetRasterBand(i+1).Fill(value)
            gdal.GetDriverByName('PNG').CreateCopy(path, raster)
            encoded = Path(path).read_bytes()
            config = {'url':'https://example/{z}/{x}/{y}', 'dimension':2, 'allowSourceFallback':True}
            def fetch(url, **kwargs):
                return io.BytesIO(b'corrupt PNG' if url.endswith('/1/1/1') else encoded)
            with patch('cube_xyz.urllib.request.urlopen', fetch), patch('cube_xyz.time.sleep'):
                image = read_tile(config, folder, 1, 1, 1)
            np.testing.assert_array_equal(image, np.tile([37, 81, 122, 255], (2, 2, 1)))
            receipts = list(Path(folder).glob('*/*.fallback.json'))
            self.assertEqual(len(receipts), 1)
            self.assertEqual(json.loads(receipts[0].read_text())['fallbackLevel'], 0)
            config['allowSourceFallback'] = False
            with patch('cube_xyz.urllib.request.urlopen', fetch), patch('cube_xyz.time.sleep'):
                with self.assertRaisesRegex(RuntimeError, 'after 5 attempts: https://example/1/1/1'):
                    read_tile(config, folder, 1, 1, 1)

    def test_pixel_centres_and_xyz_y(self):
        x, y = source_pixel(np.array([-179.5, 179.5]), np.array([89.5, -89.5]), 0, 180)
        np.testing.assert_allclose(x, [0, 359])
        np.testing.assert_allclose(y, [0, 179])

    def test_wrap_and_alpha_are_bilinear(self):
        # Antimeridian half-pixel: the east pixel is red, the west pixel is
        # transparent green. Transparent green must not contaminate the result.
        def read(config, cache, level, x, y):
            return np.array([[[255, 0, 0, 255] if x == 1 else [0, 255, 0, 0]]], np.uint8)
        config = {'dimension': 1}
        num, alpha = sample(config, np.array([180., -180.]), np.array([0., 0.]), 0, '', read)
        np.testing.assert_allclose(alpha, [0.5, 0.5])
        np.testing.assert_allclose(num / alpha[:, None], [[1, 0, 0], [1, 0, 0]])

    def test_missing_and_regional_tiles_are_transparent(self):
        config = {'dimension': 1, 'bounds': [77.16, 18.21, 77.7, 18.72]}
        num, alpha = sample(config, np.array([77.4, 78]), np.array([18.4, 18.4]), 0, '', lambda *a: None)
        self.assertEqual(alpha.max(), 0)
        self.assertEqual(num.max(), 0)
        np.testing.assert_array_equal(in_bounds(np.array([179., -179., 0.]), np.zeros(3), [170, -1, -170, 1]), [True, True, False])

    def test_refuses_implicit_latitude_or_other_source_grids(self):
        for cfg in ({}, {'latitudeConvention': 'planetographic'}, {'latitudeConvention': 'planetocentric', 'projection': 'EPSG:3857'}):
            with self.assertRaises(ValueError):
                validate({'url': 'https://example/{z}/{x}/{y}', **cfg})
        validate({'url': 'https://example/{z}/{x}/{y}', 'latitudeConvention': 'planetocentric'})


if __name__ == '__main__':
    unittest.main()
