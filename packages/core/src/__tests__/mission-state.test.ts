// External mission-state sources: evaluation, frame/time/quaternion
// normalization, coverage semantics and request orchestration, checked against
// independently computed values rather than round trips through the code.
import { describe, expect, it, vi } from 'vitest';
import {
  HostDataAdapter, MissionStateManager, OBLIQUITY_J2000_RAD, StateUnavailableError, Universe,
  exploratoryData, type AttitudeConvention, type CatalogJson, type MissionStateSink, type MissionStateSource,
  type PositionBatch, type PositionConvention, type AttitudeBatch, type CoverageInterval,
} from '../index.js';

const MU = 398600.4418;
const R = 7000;
const W = Math.sqrt(MU / R ** 3);
const INC = (51.6 * Math.PI) / 180;
const adapter = new HostDataAdapter('test-host');
const prov = (classification: 'authoritative' | 'planned' = 'authoritative') =>
  ({ id: `p-${classification}`, kind: 'trajectory' as const, classification });

/** Inclined circular orbit in J2000 about Earth: exact position and velocity. */
function orbit(t: number): { position: number[]; velocity: number[] } {
  const u = W * t;
  const [x, y] = [R * Math.cos(u), R * Math.sin(u)];
  const [vx, vy] = [-R * W * Math.sin(u), R * W * Math.cos(u)];
  return {
    position: [x, y * Math.cos(INC), y * Math.sin(INC)],
    velocity: [vx, vy * Math.cos(INC), vy * Math.sin(INC)],
  };
}

const J2000_POS: PositionConvention = {
  timeScale: 'TDB', frame: 'J2000', center: 'Earth', positionUnits: 'km', velocityUnits: 'km/s', maxSampleSpacing: 120,
};
const ATT: AttitudeConvention = {
  timeScale: 'TDB', quaternionOrder: 'scalar-first', referenceFrame: 'J2000', bodyFrame: 'SC1_BUS',
  direction: 'reference-to-body', maxSampleSpacing: 120,
};

function positionBatch(start: number, end: number, step = 60, f = orbit): PositionBatch {
  const samples = [];
  for (let t = start; t <= end; t += step) samples.push({ t, ...f(t) });
  return { window: { start, end }, samples };
}

function scene(m: MissionStateManager, item: Record<string, unknown> = {}): Universe {
  const u = new Universe(undefined, { trajectoryFactories: m.trajectoryFactories, rotationFactories: m.rotationFactories });
  u.loadCatalog({
    name: 'mission-state-test',
    items: [
      { name: 'Earth', trajectory: { type: 'FixedPoint', position: [0, 0, 0] } },
      {
        name: 'SC-1', center: 'Earth', class: 'spacecraft',
        trajectory: { type: 'MissionState', source: 'sc1' },
        rotationModel: { type: 'MissionState', source: 'sc1' },
        ...item,
      },
    ],
  } as unknown as CatalogJson);
  m.bind(u);
  return u;
}

/** A source answering requests from a function; records every request. */
function requestingSource(
  answer: (channel: string, w: CoverageInterval) => PositionBatch | AttitudeBatch | Promise<PositionBatch | AttitudeBatch>,
  extra: Partial<MissionStateSource> = {},
) {
  const requests: { channel: string; window: CoverageInterval; signal: AbortSignal; resolve?: () => void }[] = [];
  const source: MissionStateSource = {
    id: 'sc1', position: J2000_POS,
    request: async (channel, window, signal) => {
      requests.push({ channel, window, signal });
      const batch = await answer(channel, window);
      return adapter.supply(batch, prov());
    },
    ...extra,
  };
  return { source, requests };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('position evaluation', () => {
  it('interpolates within samples and transforms J2000 → ECLIPJ2000 with the obliquity', () => {
    const m = new MissionStateManager();
    const u = scene(m);
    let sink!: MissionStateSink;
    m.addSource({ id: 'sc1', position: J2000_POS, subscribe: (s) => { sink = s; return () => {}; } });
    sink.push('position', adapter.supply(positionBatch(0, 3600), prov()));

    const et = 1234.5; // between samples
    const own = u.getBody('SC-1')!.stateAt(et).position;
    const truth = orbit(et).position;
    for (let k = 0; k < 3; k++) expect(own[k]).toBeCloseTo(truth[k], 2); // < 10 m

    // Independent ECLIPJ2000 = Rx(ε) · J2000.
    const c = Math.cos(OBLIQUITY_J2000_RAD), s = Math.sin(OBLIQUITY_J2000_RAD);
    const expected = [truth[0], c * truth[1] + s * truth[2], -s * truth[1] + c * truth[2]];
    const world = u.absolutePositionOf('SC-1', et);
    for (let k = 0; k < 3; k++) expect(world[k]).toBeCloseTo(expected[k], 2);
    // The obliquity is not a rounding error: a frame mistake is ~2800 km here.
    expect(Math.abs(world[2] - truth[2])).toBeGreaterThan(1000);
  });

  it('converts metres to kilometres and UTC (with leap seconds) to ET', () => {
    const m = new MissionStateManager();
    const u = scene(m);
    let sink!: MissionStateSink;
    m.addSource({
      id: 'sc1', position: { ...J2000_POS, timeScale: 'UTC', positionUnits: 'm', velocityUnits: 'm/s' },
      subscribe: (s) => { sink = s; return () => {}; },
    });
    // 2017-01-01T00:00:00Z follows the 2016-12-31 leap second.
    // Uniform motion along +X at 7.5 km/s, sampled across the 2016-12-31 leap
    // second: midnight is 61 s after 23:59:00, so a time path that ignores the
    // leap second lands 7.5 km short.
    const x = (dt: number) => [7_000_000 + 7500 * dt, 0, 0];
    sink.push('position', adapter.supply({
      window: { start: '2016-12-31T23:59:00Z', end: '2017-01-01T00:01:00Z' },
      samples: [
        { t: '2016-12-31T23:59:00Z', position: x(0), velocity: [7500, 0, 0] },
        { t: '2016-12-31T23:59:60Z', position: x(60), velocity: [7500, 0, 0] },
        { t: '2017-01-01T00:01:00Z', position: x(121), velocity: [7500, 0, 0] },
      ],
    }, prov()));
    const et = 536500869.184; // 2017-01-01T00:00:00Z, independently: (UTC instant − J2000 UTC instant) + (37 − 32) s
    expect(u.getBody('SC-1')!.stateAt(et).position[0]).toBeCloseTo(7457.5, 6);
    expect(u.getBody('SC-1')!.stateAt(et).velocity[0]).toBeCloseTo(7.5, 9);
    // The leap second is a real sample one second before midnight's ET.
    const cov = m.status('sc1')!.position!.evaluable[0];
    expect(cov.end - cov.start).toBe(121);
  });
});

describe('attitude conventions', () => {
  // Body axes are J2000 axes turned by θ about +Z, so body +X = (cos θ, sin θ, 0) in J2000.
  const theta = 0.7;
  const refToBody = [Math.cos(theta / 2), 0, 0, -Math.sin(theta / 2)]; // v_body = q v_ref q*
  const conventions: [string, Partial<AttitudeConvention>, number[]][] = [
    ['scalar-first, reference-to-body', {}, refToBody],
    ['scalar-last, reference-to-body', { quaternionOrder: 'scalar-last' }, [refToBody[1], refToBody[2], refToBody[3], refToBody[0]]],
    ['scalar-first, body-to-reference', { direction: 'body-to-reference' }, [refToBody[0], -refToBody[1], -refToBody[2], -refToBody[3]]],
    ['scalar-last, body-to-reference', { quaternionOrder: 'scalar-last', direction: 'body-to-reference' }, [-refToBody[1], -refToBody[2], -refToBody[3], refToBody[0]]],
  ];
  for (const [label, convention, q] of conventions) {
    it(`orients the body identically when declared ${label}`, () => {
      const m = new MissionStateManager();
      const u = scene(m);
      let sink!: MissionStateSink;
      m.addSource({ id: 'sc1', attitude: { ...ATT, ...convention }, subscribe: (s) => { sink = s; return () => {}; } });
      sink.push('attitude', adapter.supply({ window: { start: 0, end: 60 }, samples: [{ t: 0, quaternion: q }, { t: 60, quaternion: q }] }, prov()));
      const [w, x, y, z] = u.bodyToWorldQuat('SC-1', 30)!;
      // Rotate body +X into the world (ECLIPJ2000) frame.
      const bx = [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
      const j2000 = [Math.cos(theta), Math.sin(theta), 0];
      const c = Math.cos(OBLIQUITY_J2000_RAD), s = Math.sin(OBLIQUITY_J2000_RAD);
      const expected = [j2000[0], c * j2000[1] + s * j2000[2], -s * j2000[1] + c * j2000[2]];
      for (let k = 0; k < 3; k++) expect(bx[k]).toBeCloseTo(expected[k], 9);
    });
  }

  it('reads back position and attitude in the source\'s own frame and convention', () => {
    const m = new MissionStateManager();
    const u = scene(m);
    let sink!: MissionStateSink;
    m.addSource({ id: 'sc1', position: J2000_POS, attitude: ATT, subscribe: (s) => { sink = s; return () => {}; } });
    sink.push('position', adapter.supply(positionBatch(0, 600), prov()));
    sink.push('attitude', adapter.supply({ window: { start: 0, end: 600 }, samples: [0, 120, 240, 360, 480, 600].map((t) => ({ t, quaternion: refToBody })) }, prov()));
    const read = u.stateIn('SC-1', 300, { frame: 'J2000' });
    for (let k = 0; k < 3; k++) expect(read.position![k]).toBeCloseTo(orbit(300).position[k], 6);
    const sign = Math.sign(read.attitude![0] * refToBody[0]);
    for (let k = 0; k < 4; k++) expect(sign * read.attitude![k]).toBeCloseTo(refToBody[k], 12);
    expect(u.stateIn('SC-1', 900, { frame: 'J2000' })).toMatchObject({ position: null, attitude: null });
    // A requested frame or centre that cannot be evaluated is a reason, never available-but-null.
    expect(u.stateIn('SC-1', 300, { frame: 'NO_SUCH_FRAME' })).toMatchObject({
      position: null, attitude: null,
      availability: { position: { available: false, reason: 'error' }, attitude: { available: false, reason: 'error' } },
    });
    expect(u.stateIn('SC-1', 300, { center: 'Vulcan' })).toMatchObject({
      position: null, availability: { position: { available: false, reason: 'unbound' }, attitude: { available: true } },
    });
  });

  it('slerps between samples', () => {
    const m = new MissionStateManager();
    const u = scene(m);
    let sink!: MissionStateSink;
    m.addSource({ id: 'sc1', attitude: ATT, subscribe: (s) => { sink = s; return () => {}; } });
    const at = (a: number) => [Math.cos(a / 2), 0, 0, -Math.sin(a / 2)];
    sink.push('attitude', adapter.supply({ window: { start: 0, end: 100 }, samples: [{ t: 0, quaternion: at(0) }, { t: 100, quaternion: at(1) }] }, prov()));
    const q = u.getBody('SC-1')!.rotationAt(25)!;
    for (let k = 0; k < 4; k++) expect(q[k]).toBeCloseTo(at(0.25)[k], 12);
  });

  it('rejects non-unit quaternions and ambiguous conventions', () => {
    const m = new MissionStateManager();
    let sink!: MissionStateSink;
    m.addSource({ id: 'sc1', attitude: ATT, subscribe: (s) => { sink = s; return () => {}; } });
    expect(() => sink.push('attitude', adapter.supply({ window: { start: 0, end: 1 }, samples: [{ t: 0, quaternion: [1, 1, 0, 0] }] }, prov())))
      .toThrow(/unit length/);
    const bad = (attitude: Partial<AttitudeConvention>) => () =>
      new MissionStateManager().addSource({ id: 'x', attitude: { ...ATT, ...attitude } as AttitudeConvention });
    expect(bad({ quaternionOrder: undefined })).toThrow(/quaternionOrder/);
    expect(bad({ direction: undefined })).toThrow(/direction/);
    expect(bad({ bodyFrame: '' })).toThrow(/bodyFrame/);
    expect(() => new MissionStateManager().addSource({ id: 'x', position: { ...J2000_POS, frame: 'BODY_FIXED' } })).toThrow(/explicitly/);
    expect(() => new MissionStateManager().addSource({ id: 'x', position: { ...J2000_POS, timeScale: 'GPS' as 'TDB' } })).toThrow(/timeScale/);
  });
});

describe('binding to the catalog', () => {
  it('reports a centre mismatch or unknown frame instead of reinterpreting', () => {
    const m = new MissionStateManager();
    const u = scene(m);
    m.addSource({ id: 'sc1', position: { ...J2000_POS, center: 'Moon' } });
    expect(u.stateAvailability('SC-1', 0).position).toMatchObject({ available: false, reason: 'error', message: expect.stringMatching(/relative to Moon/) });
    m.replaceSource({ id: 'sc1', position: { ...J2000_POS, frame: 'NOT_A_FRAME' } });
    expect(u.stateAvailability('SC-1', 0).position).toMatchObject({ available: false, reason: 'error', message: expect.stringMatching(/NOT_A_FRAME/) });
  });

  it('is unbound until the host supplies the source', () => {
    const m = new MissionStateManager();
    const u = scene(m);
    expect(u.stateAvailability('SC-1', 0).position.reason).toBe('unbound');
    expect(isNaN(u.absolutePositionOf('SC-1', 0)[0])).toBe(true);
    expect(() => u.getBody('SC-1')!.rotationAt(0)).toThrow(StateUnavailableError);
    expect(u.bodyToWorldQuat('SC-1', 0)).toBeUndefined();
  });
});

describe('coverage semantics', () => {
  function live(extra: Partial<MissionStateSource> = {}) {
    const m = new MissionStateManager({ now: () => clock.now });
    const clock = { now: 0 };
    const u = scene(m);
    let sink!: MissionStateSink;
    m.addSource({ id: 'sc1', position: J2000_POS, attitude: ATT, subscribe: (s) => { sink = s; return () => {}; }, staleAfterMs: 5000, ...extra });
    return { m, u, sink, clock };
  }
  const q0 = [1, 0, 0, 0];

  it('distinguishes before, gap, after, stale and disconnected — never holding the last state', () => {
    const { u, sink, clock } = live();
    sink.push('position', adapter.supply({ window: { start: 0, end: 1000 }, samples: [
      ...positionBatch(100, 400).samples, ...positionBatch(700, 900).samples,
    ] }, prov()));
    const reason = (et: number) => u.stateAvailability('SC-1', et).position.reason;
    expect(reason(50)).toBe('before-coverage');
    expect(reason(550)).toBe('gap');
    expect(isNaN(u.absolutePositionOf('SC-1', 550)[0])).toBe(true);
    expect(u.stateAvailability('SC-1', 300).position.available).toBe(true);
    expect(reason(950)).toBe('pending'); // connected and fresh: data is on its way
    clock.now = 6000;
    expect(reason(950)).toBe('stale');
    sink.setConnection('disconnected');
    expect(reason(950)).toBe('disconnected');
    expect(isNaN(u.getBody('SC-1')!.stateAt(950).position[0])).toBe(true);
  });

  it('keeps position and attitude coverage independent', () => {
    const { u, sink } = live({ coverage: { attitude: { start: 300, end: 900 } } });
    sink.push('position', adapter.supply(positionBatch(0, 600), prov()));
    sink.push('attitude', adapter.supply({ window: { start: 300, end: 900 }, samples: [{ t: 300, quaternion: q0 }, { t: 360, quaternion: q0 }] }, prov()));
    const at = (et: number) => u.stateAvailability('SC-1', et);
    expect(at(100)).toMatchObject({ position: { available: true }, attitude: { available: false, reason: 'before-coverage' } });
    expect(at(330)).toMatchObject({ position: { available: true }, attitude: { available: true } });
    expect(at(700)).toMatchObject({ position: { available: false }, attitude: { available: false, reason: 'gap' } });
    expect(() => u.getBody('SC-1')!.rotationAt(100)).toThrow(StateUnavailableError);
  });

  it('applies late, out-of-order live batches by time, and corrections replace their window', () => {
    const { u, sink } = live();
    sink.push('position', adapter.supply(positionBatch(600, 1200), prov()));
    sink.push('position', adapter.supply(positionBatch(0, 600), prov())); // arrives late
    expect(u.stateAvailability('SC-1', 300).position.available).toBe(true);
    const shifted = () => ({ position: [1, 2, 3], velocity: [0, 0, 0] });
    sink.push('position', adapter.supply(positionBatch(0, 600, 60, shifted), prov()));
    expect(u.getBody('SC-1')!.stateAt(300).position).toEqual([1, 2, 3]);
    expect(u.getBody('SC-1')!.stateAt(900).position[0]).toBeCloseTo(orbit(900).position[0], 2);
  });

  it('never lets predicted data overwrite observed data, and labels which is which', () => {
    const { u, sink } = live();
    sink.push('position', adapter.supply(positionBatch(0, 600), prov('authoritative')));
    sink.push('position', adapter.supply(positionBatch(0, 1800, 60, () => ({ position: [9, 9, 9], velocity: [0, 0, 0] })), prov('planned')));
    expect(u.getBody('SC-1')!.stateAt(300).position[0]).toBeCloseTo(orbit(300).position[0], 2);
    expect(u.stateAvailability('SC-1', 300).position.classification).toBe('authoritative');
    expect(u.getBody('SC-1')!.stateAt(1200).position).toEqual([9, 9, 9]);
    expect(u.stateAvailability('SC-1', 1200).position.classification).toBe('planned');
  });

  it('rejects an invalid batch atomically and keeps the authority of exploratory data', () => {
    const { u, sink } = live();
    const batch = positionBatch(0, 600);
    expect(() => sink.push('position', adapter.supply({ ...batch, samples: [...batch.samples, { t: 9999, position: [0, 0, 0], velocity: [0, 0, 0] }] }, prov()))).toThrow(/outside the batch window/);
    expect(u.stateAvailability('SC-1', 300).position.available).toBe(false);
    sink.push('position', exploratoryData(batch, prov()));
    expect(u.stateAvailability('SC-1', 300).position.authority).toBe('exploratory');
    expect(() => sink.push('position', { value: batch } as never)).toThrow(/PluginData/);
  });

  it('never interpolates across a window nobody served, or one served empty', () => {
    const { u, sink } = live();
    // Separately answered windows; the samples either side of the hole are 120 s apart, within maxSampleSpacing.
    sink.push('position', adapter.supply(positionBatch(0, 600), prov()));
    sink.push('position', adapter.supply(positionBatch(720, 1200), prov()));
    const at = (et: number) => u.stateAvailability('SC-1', et).position;
    expect(at(660)).toMatchObject({ available: false, reason: 'pending' });
    expect(isNaN(u.getBody('SC-1')!.stateAt(660).position[0])).toBe(true);
    // The source answers the hole: nothing there. A real gap, not a blend.
    sink.push('position', adapter.supply({ window: { start: 610, end: 710 }, samples: [] }, prov()));
    expect(at(660)).toMatchObject({ available: false, reason: 'gap', message: expect.stringMatching(/served no data/) });
    expect(isNaN(u.getBody('SC-1')!.stateAt(660).position[0])).toBe(true);
    expect(u.stateAvailability('SC-1', 300).position.coverage).toEqual([{ start: 0, end: 600 }]);
    // Served properly: abutting windows interpolate as one.
    sink.push('position', adapter.supply(positionBatch(600, 720), prov()));
    expect(at(660).available).toBe(true);
    expect(at(630)).toMatchObject({ available: true, coverage: [{ start: 0, end: 1200 }] });
    expect(u.getBody('SC-1')!.stateAt(630).position[0]).toBeCloseTo(orbit(630).position[0], 2);
  });

  it('never blends across an authority or observed/planned boundary', () => {
    const { u, sink } = live();
    sink.push('position', adapter.supply(positionBatch(0, 600), prov('authoritative')));
    sink.push('position', adapter.supply(positionBatch(600, 1200, 60, () => ({ position: [9, 9, 9], velocity: [0, 0, 0] })), prov('planned')));
    const at = (et: number) => u.stateAvailability('SC-1', et).position;
    expect(at(600).classification).toBe('authoritative'); // the shared instant stays observed
    expect(u.getBody('SC-1')!.stateAt(600).position[0]).toBeCloseTo(orbit(600).position[0], 6);
    expect(at(630)).toMatchObject({ available: false, reason: 'gap', message: expect.stringMatching(/not blended/) });
    expect(at(690)).toMatchObject({ available: true, classification: 'planned' });
    sink.push('position', exploratoryData(positionBatch(1200, 1800, 60, () => ({ position: [9, 9, 9], velocity: [0, 0, 0] })), prov('planned')));
    expect(at(1170)).toMatchObject({ available: false, reason: 'gap' }); // host → exploratory
    expect(at(1290)).toMatchObject({ available: true, authority: 'exploratory' });
  });

  it('never lets predicted data reopen a window the observed source answered empty', () => {
    const { u, sink } = live({ position: { ...J2000_POS, maxSampleSpacing: 60 } });
    const planned = () => adapter.supply({ window: { start: 0, end: 30 }, samples: [0, 30].map((t) => ({ t, ...orbit(t) })) }, prov('planned'));
    const at = (et: number) => u.stateAvailability('SC-1', et).position;
    sink.push('position', planned());
    expect(at(15)).toMatchObject({ available: true, classification: 'planned' });
    sink.push('position', adapter.supply({ window: { start: 10, end: 20 }, samples: [] }, prov('authoritative')));
    expect(at(15)).toMatchObject({ available: false, reason: 'gap' });
    sink.push('position', planned()); // the same prediction again
    for (const et of [5, 15, 25]) {
      expect(at(et)).toMatchObject({ available: false, reason: 'gap' });
      expect(isNaN(u.getBody('SC-1')!.stateAt(et).position[0])).toBe(true);
    }
    expect(at(0)).toMatchObject({ available: true, classification: 'planned' }); // the samples themselves stand
  });

  it('long live runs with seeks across evicted coverage stay bounded and correct', async () => {
    const MAX = 120;
    const requests: CoverageInterval[] = [];
    let open = 0, maxOpen = 0;
    const m = new MissionStateManager();
    const u = scene(m);
    let sink!: MissionStateSink;
    m.addSource({
      id: 'sc1', position: J2000_POS, maxSamples: MAX, prefetch: { behind: 1200, ahead: 600 },
      request: async (_c, w) => {
        requests.push(w);
        maxOpen = Math.max(maxOpen, ++open);
        await flush();
        open--;
        return adapter.supply({ window: w, samples: positionBatch(Math.ceil(w.start / 60) * 60, w.end).samples }, prov());
      },
      subscribe: (s) => { sink = s; return () => {}; },
    });
    const check = (et: number) => {
      const s = m.status('sc1')!.position!;
      expect(s.samples).toBeLessThanOrEqual(MAX);
      expect(s.loaded.length).toBeLessThanOrEqual(3);
      expect(s.evaluable.length).toBeLessThanOrEqual(3);
      const p = u.getBody('SC-1')!.stateAt(et).position;
      expect(Math.hypot(p[0] - orbit(et).position[0], p[1] - orbit(et).position[1], p[2] - orbit(et).position[2])).toBeLessThan(1e-3);
    };
    let edge = 0;
    for (let step = 1; step <= 2000; step++) {
      // A minute of live data per step, following the playhead.
      sink.push('position', adapter.supply(positionBatch(edge, edge + 60), prov()));
      edge += 60;
      m.focus(edge - 30);
      await flush(); // a frame
      if (step % 250 === 0) {
        // Back into coverage long since evicted, and forward again.
        const back = edge * 0.37 + 15;
        m.focus(back);
        await flush(); await flush();
        check(back);
        m.focus(edge - 30);
        await flush(); await flush();
      }
      if (step % 50 === 0) check(edge - 30);
    }
    expect(maxOpen).toBeLessThanOrEqual(2);
    // Chunked: one ahead-request per half prefetch window of playback, plus a few per seek.
    expect(requests.length).toBeLessThanOrEqual((2000 * 60) / 300 + 8 * 3);
  });

  it('bounds retention, evicting farthest from the playhead', () => {
    const { m, sink } = live({ maxSamples: 20 });
    m.focus(60 * 50);
    sink.push('position', adapter.supply(positionBatch(0, 60 * 100), prov()));
    const s = m.status('sc1')!.position!;
    expect(s.samples).toBe(20);
    expect(s.evaluable[0].start).toBeGreaterThan(60 * 35);
    expect(s.evaluable[0].end).toBeLessThan(60 * 65);
  });
});

describe('request orchestration', () => {
  it('prefetches around the playhead, without re-requesting what is loaded or in flight', async () => {
    const { source, requests } = requestingSource((_c, w) => positionBatch(Math.ceil(w.start / 60) * 60, w.end), { prefetch: { behind: 600, ahead: 600 } });
    const m = new MissionStateManager();
    const u = scene(m);
    m.addSource(source);
    m.focus(10_000);
    expect(requests).toHaveLength(1);
    expect(requests[0].window).toEqual({ start: 9400, end: 10_600 });
    m.focus(10_001);
    expect(requests).toHaveLength(1); // in flight
    await flush();
    expect(u.stateAvailability('SC-1', 10_000).position.available).toBe(true);
    m.focus(10_200); // still inside the inner half
    expect(requests).toHaveLength(1);
    m.focus(10_400); // leading edge: fetch only what is missing
    expect(requests[1].window).toEqual({ start: 10_600, end: 11_000 });
  });

  it('aborts obsolete requests on a rapid seek and discards their late answers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { source, requests } = requestingSource(async (_c, w) => { await gate; return positionBatch(Math.ceil(w.start / 60) * 60, w.end); },
      { prefetch: { behind: 600, ahead: 600 } });
    const m = new MissionStateManager();
    const u = scene(m);
    m.addSource(source);
    m.focus(10_000);
    m.focus(50_000); // seek far away
    expect(requests[0].signal.aborted).toBe(true);
    expect(requests[1].signal.aborted).toBe(false);
    release();
    await flush();
    expect(u.stateAvailability('SC-1', 10_000).position.reason).toBe('pending'); // late answer dropped
    expect(u.stateAvailability('SC-1', 50_000).position.available).toBe(true);
  });

  it('drops answers that arrive after the source was replaced', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = requestingSource(async () => { await gate; return positionBatch(9400, 10_600, 60, () => ({ position: [1, 1, 1], velocity: [0, 0, 0] })); });
    const m = new MissionStateManager();
    const u = scene(m);
    m.addSource(first.source);
    m.focus(10_000);
    m.replaceSource({ id: 'sc1', position: J2000_POS }); // no data at all
    expect(first.requests[0].signal.aborted).toBe(true);
    release();
    await flush();
    expect(u.stateAvailability('SC-1', 10_000).position.available).toBe(false);
  });

  it('reports a failed request as an error, then retries', async () => {
    const clock = { now: 0 };
    let fail = true;
    const { source, requests } = requestingSource((_c, w) => (fail ? Promise.reject(new Error('backend 503')) : positionBatch(Math.ceil(w.start / 60) * 60, w.end)));
    const m = new MissionStateManager({ now: () => clock.now });
    const u = scene(m);
    m.addSource(source);
    m.focus(10_000);
    await flush();
    expect(u.stateAvailability('SC-1', 10_000).position).toMatchObject({ reason: 'error', message: expect.stringMatching(/backend 503/) });
    m.focus(10_000);
    expect(requests).toHaveLength(1); // backing off
    clock.now = 5000;
    fail = false;
    m.focus(10_000);
    await flush();
    expect(u.stateAvailability('SC-1', 10_000).position.available).toBe(true);
  });

  it('backs off from a source that answers less than it was asked', async () => {
    const clock = { now: 0 };
    // Answers only the first half of each window it is asked for.
    const { source, requests } = requestingSource((_c, w) => positionBatch(w.start, (w.start + w.end) / 2));
    const m = new MissionStateManager({ now: () => clock.now });
    scene(m);
    m.addSource(source);
    m.focus(10_000);
    await flush();
    for (let k = 0; k < 20; k++) m.focus(10_000 + k);
    expect(m.status('sc1')!.position!.error).toBeUndefined();
    expect(requests).toHaveLength(1);
    clock.now = 5000;
    m.focus(10_000);
    expect(requests).toHaveLength(2);
  });

  it('keeps the previous source working when the replacement cannot subscribe', () => {
    const m = new MissionStateManager();
    const u = scene(m);
    let sink!: MissionStateSink;
    const unsubscribe = vi.fn();
    m.addSource({ id: 'sc1', position: J2000_POS, subscribe: (s) => { sink = s; return unsubscribe; } });
    sink.push('position', adapter.supply(positionBatch(0, 600), prov()));
    expect(() => m.replaceSource({ id: 'sc1', position: J2000_POS, subscribe: () => { throw new Error('link refused'); } })).toThrow(/link refused/);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(u.stateAvailability('SC-1', 300).position.available).toBe(true);
    sink.push('position', adapter.supply(positionBatch(600, 1200), prov())); // the old feed still lands
    expect(u.stateAvailability('SC-1', 900).position.available).toBe(true);
    expect(() => m.addSource({ id: 'sc2', position: J2000_POS, subscribe: () => { throw new Error('nope'); } })).toThrow(/nope/);
    expect(m.sourceIds()).toEqual(['sc1']);
  });

  it('rejects non-finite or out-of-range retention and prefetch bounds', () => {
    const m = new MissionStateManager();
    for (const extra of [{ maxSamples: -1 }, { maxSamples: 1.5 }, { maxSamples: Infinity }, { prefetch: { behind: -10 } }, { prefetch: { ahead: NaN } }, { staleAfterMs: -1 }]) {
      expect(() => m.addSource({ id: 'sc1', position: J2000_POS, ...extra })).toThrow(/must be/);
    }
    expect(m.sourceIds()).toEqual([]);
  });

  it('invalidates only the bound body\'s trail, coalesced, and stops everything on dispose', async () => {
    vi.useFakeTimers();
    try {
      const m = new MissionStateManager();
      const u = scene(m);
      const changed: string[] = [];
      u.events.on('body:trajectoryChanged', ({ body }) => changed.push(body.name));
      let sink!: MissionStateSink;
      const unsubscribe = vi.fn();
      m.addSource({ id: 'sc1', position: J2000_POS, subscribe: (s) => { sink = s; return unsubscribe; } });
      changed.length = 0;
      for (let k = 0; k < 5; k++) sink.push('position', adapter.supply(positionBatch(k * 600, (k + 1) * 600), prov()));
      vi.advanceTimersByTime(250);
      expect(changed).toEqual(['SC-1']);
      m.dispose();
      expect(unsubscribe).toHaveBeenCalledOnce();
      expect(() => m.addSource({ id: 'y', position: J2000_POS })).toThrow(/disposed/);
    } finally {
      vi.useRealTimers();
    }
  });
});
