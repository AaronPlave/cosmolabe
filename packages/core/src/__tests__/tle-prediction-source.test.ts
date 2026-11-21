// A TLE prediction as a mission-state source: J2000 states inside its validity,
// classified planned, and nothing outside it.
import { describe, expect, it } from 'vitest';
import { HostDataAdapter, TLETrajectory, etFromCalendarString, tlePredictionSource } from '../index.js';

// ISS, CelesTrak, epoch 2026-11-05.
const L1 = '1 25544U 98067A   26309.85296296  .00010000  00000-0  18000-3 0  9990';
const L2 = '2 25544  51.6300 120.0000 0005000  90.0000 270.0000 15.50000000 10000';
const adapter = new HostDataAdapter('test');

describe('tlePredictionSource', () => {
  const source = tlePredictionSource({ id: 'iss-predicted', line1: L1, line2: L2, validFrom: '2026-11-05T00:00:00Z', validTo: '2026-11-07T00:00:00Z', adapter });
  const t0 = etFromCalendarString('2026-11-06T00:00:00Z');

  it('serves planned J2000 states inside its validity, one TEME rotation from SGP4', async () => {
    const batch = await source.request!('position', { start: t0, end: t0 + 120 }, new AbortController().signal);
    expect(batch.provenance.classification).toBe('planned');
    const samples = (batch.value as unknown as { samples: { t: number; position: number[] }[] }).samples;
    expect(samples.length).toBe(4);
    expect(samples[1].t - samples[0].t).toBe(30);
    const teme = new TLETrajectory({ line1: L1, line2: L2 }).stateAt(samples[0].t).position;
    const j2000 = samples[0].position;
    // A rotation (same length), and not the identity: ~26 years of precession since J2000.
    expect(Math.hypot(...j2000)).toBeCloseTo(Math.hypot(...teme), 6);
    expect(Math.hypot(j2000[0] - teme[0], j2000[1] - teme[1], j2000[2] - teme[2])).toBeGreaterThan(10);
  });

  it('serves nothing outside its validity', async () => {
    const after = etFromCalendarString('2026-11-08T00:00:00Z');
    const batch = await source.request!('position', { start: after, end: after + 600 }, new AbortController().signal);
    expect((batch.value as unknown as { samples: unknown[] }).samples).toEqual([]);
    expect(source.coverage!.position!.end).toBe(etFromCalendarString('2026-11-07T00:00:00Z'));
  });

  it('refuses an empty validity', () => {
    expect(() => tlePredictionSource({ id: 'x', line1: L1, line2: L2, validFrom: '2026-11-07T00:00:00Z', validTo: '2026-11-05T00:00:00Z', adapter })).toThrow(/validTo/);
  });
});

describe('tlePredictionSource.stateAt', () => {
  it('evaluates inside the validity and nowhere else', () => {
    const s = tlePredictionSource({ id: 'p', line1: L1, line2: L2, validFrom: '2026-11-05T00:00:00Z', validTo: '2026-11-07T00:00:00Z', adapter });
    expect(Math.hypot(...s.stateAt(etFromCalendarString('2026-11-06T00:00:00Z'))!.position)).toBeGreaterThan(6600);
    expect(s.stateAt(etFromCalendarString('2026-11-08T00:00:00Z'))).toBeNull();
  });
});
