// A sensor on a spacecraft whose attitude a host supplies: pointed by that
// attitude through the catalog mounting, checked against an independently
// rotated boresight — and refused, with a reason, when no mounting is declared.
import { describe, expect, it } from 'vitest';
import {
  HostDataAdapter, MissionStateManager, OBLIQUITY_J2000_RAD, Universe, type CatalogJson,
} from '@cosmolabe/core';
import { parseSensorMounting, sensorPointing } from '../SensorFrustum.js';

const adapter = new HostDataAdapter('test-host');
// Reference (J2000) → body, scalar-first: 40° about a skew axis.
const axis = [1, 2, 2].map((x) => x / 3);
const half = (40 * Math.PI) / 360;
const q = [Math.cos(half), ...axis.map((x) => x * Math.sin(half))];

/** Body vector → J2000 (v_ref = q* v_body q), by explicit quaternion products. */
function bodyToJ2000(v: number[]): number[] {
  const [w, x, y, z] = [q[0], -q[1], -q[2], -q[3]]; // q*
  const mul = (a: number[], b: number[]) => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
  return mul(mul([w, x, y, z], [0, ...v]), q).slice(1);
}
const j2000ToEcliptic = (v: number[]) => {
  const c = Math.cos(OBLIQUITY_J2000_RAD), s = Math.sin(OBLIQUITY_J2000_RAD);
  return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
};

function scene(sensors: Record<string, unknown>[]) {
  const m = new MissionStateManager();
  const u = new Universe(undefined, { trajectoryFactories: m.trajectoryFactories, rotationFactories: m.rotationFactories });
  u.loadCatalog({
    name: 'sensor-host-attitude',
    items: [
      { name: 'Earth', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      { name: 'SC-1', center: 'Earth', trajectory: { type: 'FixedPoint', position: [7000, 0, 0] }, rotationModel: { type: 'MissionState', source: 'sc1' } },
      ...sensors.map((geometry, k) => ({ name: `Sensor-${k}`, center: 'SC-1', trajectory: { type: 'FixedPoint', position: [0, 0, 0] }, geometry: { type: 'Sensor', target: 'Earth', ...geometry } })),
    ],
  } as unknown as CatalogJson);
  m.bind(u);
  m.addSource({
    id: 'sc1',
    attitude: { timeScale: 'TDB', quaternionOrder: 'scalar-first', referenceFrame: 'J2000', bodyFrame: 'SC1_BUS', direction: 'reference-to-body', maxSampleSpacing: 300 },
    subscribe: (sink) => {
      sink.push('attitude', adapter.supply({ window: { start: 0, end: 600 }, samples: [0, 300, 600].map((t) => ({ t, quaternion: q })) }, { id: 'att', kind: 'attitude', classification: 'reconstructed' }));
      return () => {};
    },
  });
  const sensor = (k: number, mounting?: unknown) => {
    const parsed = parseSensorMounting(mounting);
    return { body: u.getBody(`Sensor-${k}`)!, mounting: parsed.matrix, mountingError: parsed.error, spiceFovFrame: undefined, spiceInertialFrame: 'ECLIPJ2000' };
  };
  return { u, sensor };
}

describe('sensors on host-supplied attitude', () => {
  it('points through the attitude and the declared mounting', () => {
    // Boresight along body −X, up along body +Z.
    const mounting = { boresight: [-1, 0, 0], up: [0, 0, 1] };
    const { u, sensor } = scene([{ mounting }]);
    const p = sensorPointing(u, sensor(0, mounting), 150, undefined);
    expect(p.from).toBe('attitude');
    expect(p.unavailable).toBeUndefined();
    const r = p.rotation!;
    const col = (j: number) => [r[j], r[3 + j], r[6 + j]];
    const expectBoresight = j2000ToEcliptic(bodyToJ2000([-1, 0, 0]));
    const expectUp = j2000ToEcliptic(bodyToJ2000([0, 0, 1]));
    for (let k = 0; k < 3; k++) {
      expect(col(2)[k]).toBeCloseTo(expectBoresight[k], 12);
      expect(col(1)[k]).toBeCloseTo(expectUp[k], 12);
    }
    // Outside attitude coverage: no pointing, with the reason.
    expect(sensorPointing(u, sensor(0, mounting), 900, undefined)).toMatchObject({ unavailable: expect.stringMatching(/unavailable/) });
  });

  it('refuses to aim at the target when no mounting is declared, or it is invalid', () => {
    const { u, sensor } = scene([{}, {}]);
    expect(sensorPointing(u, sensor(0), 150, undefined)).toEqual({ from: 'attitude', unavailable: expect.stringMatching(/declares no mounting/) });
    expect(sensorPointing(u, sensor(1, { boresight: [0, 0, 1], up: [0, 0, 2] }), 150, undefined)).toMatchObject({ unavailable: expect.stringMatching(/parallel/) });
  });
});
