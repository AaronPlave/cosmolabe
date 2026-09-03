import { describe, it, expect } from 'vitest';
import { intervalsToCzml, groundTrackToCzml } from './czml.js';

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

describe('groundTrackToCzml epoch labels are read as UTC', () => {
  /** Run with process.env.TZ set, restoring it after. */
  function inTimezone<T>(tz: string, fn: () => T): T {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      process.env.TZ = prev;
    }
  }

  /** Offset-less labels straddling the 2024 US spring-forward (02:00 -> 03:00). */
  const DST_SAMPLES = [
    { epoch: '2024-03-10T01:30:00', lonDeg: 0, latDeg: 0, heightM: 0 },
    { epoch: '2024-03-10T04:30:00', lonDeg: 1, latDeg: 1, heightM: 0 },
  ];

  function relativeSeconds(tz: string) {
    return inTimezone(tz, () => {
      const czml = JSON.parse(groundTrackToCzml('t', DST_SAMPLES));
      return czml[1].position.cartographicDegrees[4] as number;
    });
  }

  it('spans three hours regardless of the machine timezone', () => {
    // The literal 3 h the labels describe, stated independently of the code.
    const threeHours = 3 * 3600;
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Europe/Berlin']) {
      expect(relativeSeconds(tz), tz).toBe(threeHours);
    }
  });

  it('stays sensitive to the defect it guards', () => {
    // Date.parse reads these as local time, and the DST discontinuity means the
    // offsets differ between the two samples, so it reports 2 h. If this ever
    // stops holding, the test above has quietly become vacuous.
    const naive = inTimezone('America/Los_Angeles', () =>
      (Date.parse(DST_SAMPLES[1].epoch) - Date.parse(DST_SAMPLES[0].epoch)) / 1000,
    );
    expect(naive).toBe(2 * 3600);
  });

  it('leaves an explicit offset alone', () => {
    const czml = JSON.parse(
      groundTrackToCzml('t', [
        { epoch: '2024-03-10T01:30:00-08:00', lonDeg: 0, latDeg: 0, heightM: 0 },
        { epoch: '2024-03-10T04:30:00-07:00', lonDeg: 1, latDeg: 1, heightM: 0 },
      ]),
    );
    // 09:30Z to 11:30Z is genuinely 2 h — an author who writes offsets means them.
    expect(czml[1].position.cartographicDegrees[4]).toBe(2 * 3600);
  });
});
