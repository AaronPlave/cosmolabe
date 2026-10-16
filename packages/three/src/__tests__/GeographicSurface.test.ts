import { describe, it, expect } from 'vitest';
import { parseGeographicGeoJson, type TerrainDatum } from '@cosmolabe/core';
import { geographicPositionOnSurface } from '../surface/GeographicSurface.js';
import { ReferenceEllipsoidSurface } from '../surface/ReferenceEllipsoidSurface.js';

const layer = parseGeographicGeoJson('{"type":"FeatureCollection","features":[]}', {
  id: 'sites', name: 'Sites', body: 'Moon', source: 'sites.geojson',
  coordinates: { latitude: 'planetographic', longitudeDirection: 'east', longitudeDomain: '-180..180',
    referenceShape: { kind: 'sphere', radiusKm: 1737.4 } },
}, { kind: 'local-file', identity: 'sites.geojson' });

describe('geographic positions on the physical surface', () => {
  it('uses absolute kilometer heights without consulting display geometry', () => {
    expect(geographicPositionOnSurface(layer, { latDeg: 0, lonDeg: 0, heightKm: 1.2 })).toEqual({ xKm: 1738.6000000000001, yKm: 0, zKm: 0 });
  });
  it('keeps a 2D point unresolved when terrain is unavailable, rather than assuming zero terrain height', () => {
    expect(geographicPositionOnSurface(layer, { latDeg: 0, lonDeg: 0 })).toBeNull();
    const reference = new ReferenceEllipsoidSurface('Moon', 'IAU_MOON', [1737.4, 1737.4, 1737.4]);
    expect(geographicPositionOnSurface(layer, { latDeg: 0, lonDeg: 0 }, reference)).toBeNull();
  });
  it('uses a physical elevation sample only for the declared body/frame/reference shape and supported datum', () => {
    const datum: TerrainDatum = layer.datum;
    const surface = {
      ...new ReferenceEllipsoidSurface('Moon', 'IAU_MOON', [1737.4, 1737.4, 1737.4]),
      intersectRay: new ReferenceEllipsoidSurface('Moon', 'IAU_MOON', [1737.4, 1737.4, 1737.4]).intersectRay,
      sampleElevation: () => ({ position: { latDeg: 0, lonDeg: 0 }, elevationKm: 2,
        datum, source: { id: 'lola', kind: 'height-grid' as const } }),
    };
    expect(geographicPositionOnSurface(layer, { latDeg: 0, lonDeg: 0 }, surface)?.xKm).toBeCloseTo(1739.4);
    surface.metadata.bodyId = 'Mars';
    expect(geographicPositionOnSurface(layer, { latDeg: 0, lonDeg: 0 }, surface)).toBeNull();
    surface.metadata.bodyId = 'Moon';
    datum.verticalDatum = 'unknown';
    expect(geographicPositionOnSurface(layer, { latDeg: 0, lonDeg: 0 }, surface)).toBeNull();
  });
});
