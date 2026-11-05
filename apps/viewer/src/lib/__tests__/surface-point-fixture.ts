import { resolveSurfaceAltitude, type SurfacePoint } from '@cosmolabe/three';
export function probePoint(bodyName = 'Earth', position: readonly [number, number, number] = [1, 2, 3], source: SurfacePoint['source'] = 'surface-overlay'): SurfacePoint {
  const datum: SurfacePoint['hit']['datum'] = { referenceShape: { kind: 'ellipsoid', radiiKm: [6378, 6378, 6357] }, verticalDatum: 'areoid', heightConvention: 'geodetic-normal', origin: 'terrain' };
  const hit = { heightKm: 0.123, datum };
  return { bodyName, bodyFixedPositionKm: position, source, latDeg: 12, lonDeg: 34, latitudeKind: 'geodetic',
    resolution: { surfaceKm: 0.01, latDeg: 0.001, lonDeg: 0.002 }, surfaceNormal: [0, 0, 1], hit,
    ...resolveSurfaceAltitude(source, hit, { elevationKm: -2, datum, sourceId: 'global-dem', tileId: '4/2/3' }) };
}
