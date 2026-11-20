import { describe, expect, it, vi } from 'vitest';
import { Body, FixedPointTrajectory, FixedRotation, Universe, type Place } from '@cosmolabe/core';
import { placeDistance } from '../place-distance';

function fixture() {
  const universe = new Universe();
  universe.addBody(new Body({ name: 'Mars', trajectory: new FixedPointTrajectory([0,0,0]), rotation: new FixedRotation([1,0,0,0], 'ECLIPJ2000', 'IAU_MARS') }));
  universe.addBody(new Body({ name: 'Ingenuity', parentName: 'Mars', trajectory: new FixedPointTrajectory([10,3,0]), trajectoryFrame: 'IAU_MARS' }));
  const place = { ref: 'mars:belva', layer: { body: 'Mars', frame: 'IAU_MARS', datum: { referenceShape: { kind: 'sphere', radiusKm: 10 }, verticalDatum: 'reference-sphere', heightConvention: 'radial' } }, feature: { geometry: { type: 'Point', coordinates: { latDeg: 0, lonDeg: 0 } } } } as Place;
  return { universe, place };
}
describe('shared Place endpoint distance', () => {
  it('reads distance to the mapped anchor with native frame, datum and epoch coverage', () => {
    const { universe, place } = fixture();
    const result = placeDistance(universe, 'Ingenuity', place, 123);
    expect(result).toMatchObject({ status: 'available', et: 123, frame: 'IAU_MARS', body: 'Mars', distanceKm: 3, coverage: 'available-at-epoch', accuracyKm: null });
    expect(result.datum).toEqual(place.layer.datum);
    expect(result.limitations.join(' ')).toMatch(/closest-time search.*not supported/);
    expect(result.limitations.join(' ')).toMatch(/not distance to the crater rim/);
  });
  it('preserves mapped height instead of reclamping to the reference or terrain', () => {
    const { universe, place } = fixture();
    if (place.feature.geometry.type === 'Point') place.feature.geometry.coordinates.heightKm = 4;
    expect(placeDistance(universe, 'Ingenuity', place, 0).distanceKm).toBe(5);
  });
  it('refuses unavailable source position, mismatched frame, and unsupported datum', () => {
    const { universe, place } = fixture();
    vi.spyOn(universe, 'stateIn').mockReturnValueOnce({ position: null, attitude: null, availability: { position: { available: false, reason: 'before-coverage' } } } as ReturnType<Universe['stateIn']>);
    expect(placeDistance(universe, 'Ingenuity', place, -1)).toMatchObject({ distanceKm: null, coverage: 'unavailable' });
    place.layer.frame = 'UNREGISTERED_FRAME';
    expect(placeDistance(universe, 'Ingenuity', place, 0).reason).toBe('incompatible-body-fixed-frame');
    place.layer.frame = 'IAU_MARS'; place.layer.datum.verticalDatum = 'areoid';
    expect(placeDistance(universe, 'Ingenuity', place, 0).reason).toBe('unsupported-datum');
  });
});
