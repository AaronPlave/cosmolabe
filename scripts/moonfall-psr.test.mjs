import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseGeographicGeoJson } from '../packages/core/src/geographic/import.ts';
import { GeographicIndex, VECTOR_RENDER_PAGE_LIMIT } from '../packages/three/src/geographic/GeographicIndex.ts';

it('preserves the Shackleton stroke fixture and polar clipping regression', () => {
  const source = new URL('../apps/viewer/test-catalogs/places/moonfall-psr-295d61bce287e2be.geojson', import.meta.url);
  const definition = {
    id: 'psr-stroke-regression', name: 'Shackleton PSR stroke regression', body: 'Moon', source: source.href,
    coordinates: {
      frame: 'MOON_ME_DE421', latitude: 'planetocentric', longitudeDirection: 'east', longitudeDomain: '-180..180',
      referenceShape: { kind: 'sphere', radiusKm: 1737.4 },
    },
    display: { visible: true, color: '#6ccbd8', opacity: 0.82, fillOpacity: 0.035 },
  };
  const text = readFileSync(source, 'utf8');
  expect(createHash('sha256').update(text).digest('hex')).toBe('295d61bce287e2be53a2c32f26faab51639fcc78c86b942428188b6b8c567b0b');
  const layer = parseGeographicGeoJson(text, definition, { kind: 'catalog', identity: source.href });
  expect(layer.diagnostics).toEqual([]);
  expect(layer.frame).toBe('MOON_ME_DE421');
  expect(layer.features.map(feature => feature.sourceId)).toEqual([13, 921, 1266]);
  const polygons = layer.features.flatMap(({ geometry }) =>
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates,
  );
  expect(polygons).toHaveLength(12);
  expect(polygons.reduce((holes, polygon) => holes + polygon.length - 1, 0)).toBe(4);

  const index = new GeographicIndex([layer]);
  expect(index.features).toHaveLength(3);
  expect(index.diagnostics).toEqual([]);
  expect(index.renderPages).toBeLessThanOrEqual(VECTOR_RENDER_PAGE_LIMIT);
  const packed = index.pack();
  expect(packed.detail?.levels[0]?.chart).toBe('south-polar');
  expect(packed.detail?.levels[0]?.pages).toBeLessThan(packed.pages);

  // A real vertex on the visible section that vanished in the browser. Five
  // CSS pixels here span more than the longitude index's six-degree cap.
  const ring = layer.features[0].geometry.coordinates[0];
  const outlines = new GeographicIndex([{
    ...layer,
    features: [{ ...layer.features[0], geometry: { type: 'LineString', coordinates: ring } }],
  }]);
  expect(outlines.pick(ring[350], [1.6, 0], [0, 0.0015])).toBeNull();
  outlines.pack();
  expect(outlines.pick(ring[350], [1.6, 0], [0, 0.0015])?.featureId).toBe('number:13');
});
