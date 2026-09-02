import { describe, it, expect } from 'vitest';
import { intervalsToCzml, groundTrackToCzml } from './czml.ts';

describe('intervalsToCzml', () => {
  it('emits a document packet and availability intervals', () => {
    const czml = JSON.parse(
      intervalsToCzml('passes', [
        { start: '2004-001T00:00:00Z', stop: '2004-001T00:10:00Z' },
        { start: '2004-001T01:00:00Z', stop: '2004-001T01:10:00Z' },
      ]),
    );
    expect(czml[0]).toMatchObject({ id: 'document', version: '1.0' });
    expect(czml[1].id).toBe('passes');
    expect(czml[1].availability).toEqual([
      '2004-001T00:00:00Z/2004-001T00:10:00Z',
      '2004-001T01:00:00Z/2004-001T01:10:00Z',
    ]);
  });

  it('uses a single availability string for one interval', () => {
    const czml = JSON.parse(intervalsToCzml('x', [{ start: '2020-01-01T00:00:00Z', stop: '2020-01-01T01:00:00Z' }]));
    expect(czml[1].availability).toBe('2020-01-01T00:00:00Z/2020-01-01T01:00:00Z');
  });
});

describe('groundTrackToCzml', () => {
  it('emits a time-tagged cartographicDegrees path', () => {
    const czml = JSON.parse(
      groundTrackToCzml('track', [
        { epoch: '2020-01-01T00:00:00Z', lonDeg: 0, latDeg: 0, heightM: 500000 },
        { epoch: '2020-01-01T00:01:00Z', lonDeg: 1, latDeg: 2, heightM: 510000 },
      ]),
    );
    expect(czml[1].position.epoch).toBe('2020-01-01T00:00:00Z');
    // [t0, lon, lat, h, t1, lon, lat, h]; t1 is 60 s after the reference epoch.
    expect(czml[1].position.cartographicDegrees).toEqual([0, 0, 0, 500000, 60, 1, 2, 510000]);
  });
});
