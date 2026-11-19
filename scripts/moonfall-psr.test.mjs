import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parseGeographicGeoJson } from '../packages/core/src/geographic/import.ts';
import { GeographicIndex, VECTOR_RENDER_PAGE_LIMIT } from '../packages/three/src/geographic/GeographicIndex.ts';

it('ships the complete Shackleton PSR subset within the normal vector renderer budget', () => {
  const catalog = new URL('../apps/viewer/test-catalogs/moonfall-shackleton.json', import.meta.url);
  const definition = JSON.parse(readFileSync(catalog, 'utf8')).geographicLayers.find(layer => layer.id === 'moon:science:barker-psr');
  const source = new URL(definition.source, catalog);
  const text = readFileSync(source, 'utf8');
  expect(createHash('sha256').update(text).digest('hex')).toBe(definition.provenance.sha256);
  expect(definition.loadOnDemand).toBe(true);
  expect(definition.display.visible).toBe(false);

  const shown = { ...definition, display: { ...definition.display, visible: true } };
  const layer = parseGeographicGeoJson(text, shown, { kind: 'catalog', identity: source.href });
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
});
