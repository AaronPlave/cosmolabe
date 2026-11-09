import { describe, it, expect } from 'vitest';
import { MissionStateManager, TLETrajectory, etFromDate } from '@cosmolabe/core';
import { createLiveIssFeed, type LiveIssConfig } from './source.js';
import { ReplayTransport } from './transport.js';
import { inertialToLvlh, quatRotate, type Quat } from './frames.js';
import { parseTle } from './orbit.js';
import { L1, L2 } from './__fixtures__/tle.js';

const TLE = parseTle(`${L1}\n${L2}`, { source: 'test', sourceUrl: 'https://example.test', retrievedAtMs: 0 });
const ITEMS = ['A', 'B', 'C', 'D'] as const;
const JOINT_KEYS = ['truss:S4', 'truss:P4', ...['P4_01', 'P4_02', 'P6_01', 'P6_02', 'S4_01', 'S4_02', 'S6_01', 'S6_02'].map((a) => `array:${a}`)];
const jointItem = (key: string) => `J_${key.split(':')[1]}`;
const ALL_J = JOINT_KEYS.map(jointItem);
const CONFIG: LiveIssConfig = {
  attitude: { items: ITEMS, order: 'scalar-first', convention: { reference: 'LVLH', direction: 'reference-to-body' }, verification: 'unverified' },
  joints: { items: Object.fromEntries(JOINT_KEYS.map((k) => [k, jointItem(k)])), unit: 'deg', offsetsRad: { 'truss:S4': 0.1 } },
};

function setup(config: LiveIssConfig = CONFIG, withOrbit = true) {
  const clock = { ms: TLE.epochMs + 2 * 3_600_000 };
  const transport = new ReplayTransport();
  const feed = createLiveIssFeed({ config, transport, now: () => clock.ms, staleAfterMs: 10_000, acceptUnverified: true });
  if (withOrbit) feed.setOrbit(TLE);
  const manager = new MissionStateManager({ now: () => clock.ms });
  manager.addSource(feed.source);
  const sendAttitude = (srcMs: number, q: readonly number[] = [1, 0, 0, 0]) => ITEMS.forEach((item, i) => transport.item({ item, value: q[i], sourceTimeMs: srcMs }));
  const et = (ms: number) => etFromDate(new Date(ms));
  return { clock, transport, feed, manager, sendAttitude, et };
}

describe('live ISS feed through MissionState', () => {
  it('composes a coherent sample with the same-epoch orbit and publishes both channels', () => {
    const { clock, transport, feed, manager, sendAttitude, et } = setup();
    transport.connection('connected');
    const t = clock.ms - 1000;
    sendAttitude(t);

    const e = et(t);
    expect(manager.availability('ISS-LIVE', 'attitude', e)).toMatchObject({ available: true, classification: 'reconstructed' });
    expect(manager.availability('ISS-LIVE', 'position', e)).toMatchObject({ available: true });

    // Independent computation: SGP4 state at the sample epoch, LVLH from that state, identity telemetry.
    const state = new TLETrajectory(TLE).stateAt(e);
    const expected = inertialToLvlh(state.position, state.velocity)!;
    const got = manager.evaluateAttitude('ISS-LIVE', e) as unknown as Quat;
    const v: [number, number, number] = [0.3, -0.5, 0.8];
    const a = quatRotate(got, v), b = quatRotate(expected, v);
    for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k], 9);
    const pos = manager.evaluatePosition('ISS-LIVE', e);
    for (let k = 0; k < 3; k++) expect(pos.position[k]).toBeCloseTo(state.position[k], 6);
    expect(Math.hypot(...pos.position)).toBeGreaterThan(6600);

    const s = feed.status();
    expect(s).toMatchObject({ state: 'live', connection: 'connected', orbit: { state: 'current', source: 'test' }, attitude: { verification: 'unverified' } });
    expect(s.sourceAgeMs).toBe(1000);
    expect(manager.availability('ISS-LIVE', 'position', e).provenance?.source).toContain('estimated, not observed');
  });

  it('interpolates between consecutive samples but never extrapolates past the newest', () => {
    const { clock, transport, manager, sendAttitude, et } = setup();
    transport.connection('connected');
    sendAttitude(clock.ms - 3000);
    sendAttitude(clock.ms - 2000, [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    expect(manager.availability('ISS-LIVE', 'attitude', et(clock.ms - 2500)).available).toBe(true);
    const after = manager.availability('ISS-LIVE', 'attitude', et(clock.ms - 1000));
    expect(after.available).toBe(false);
    expect(manager.evaluatePosition('ISS-LIVE', et(clock.ms - 1000)).position.every(Number.isNaN)).toBe(true);
  });

  it('ignores partial and incoherent frames; rejects stale, out-of-order and duplicate values', () => {
    const { clock, transport, feed, manager, sendAttitude, et } = setup();
    transport.connection('connected');
    transport.item({ item: 'A', value: 1, sourceTimeMs: clock.ms - 1000 });
    transport.item({ item: 'B', value: 0, sourceTimeMs: clock.ms - 1000 });
    expect(manager.availability('ISS-LIVE', 'attitude', et(clock.ms - 1000)).available).toBe(false);
    sendAttitude(clock.ms - 40_000); // far older than the live window: a replayed snapshot
    expect(feed.status().counters.rejected.stale).toBe(4);
    sendAttitude(clock.ms - 1000);
    sendAttitude(clock.ms - 5000); // older than what is already shown
    expect(feed.status().counters.rejected['out-of-order']).toBeGreaterThan(0);
    expect(feed.status().counters.attitudeSamples).toBe(1);
  });

  it('does not publish without a current orbit, and says why; a fresh element set recovers', () => {
    const { clock, transport, feed, manager, sendAttitude, et } = setup(CONFIG, false);
    transport.connection('connected');
    sendAttitude(clock.ms - 2000);
    expect(manager.availability('ISS-LIVE', 'attitude', et(clock.ms - 2000)).available).toBe(false);
    expect(feed.status()).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('orbit') });
    expect(feed.status().counters.orbitUnavailable).toBe(1);
    feed.setOrbit(TLE);
    sendAttitude(clock.ms - 1000);
    expect(manager.availability('ISS-LIVE', 'attitude', et(clock.ms - 1000)).available).toBe(true);
  });

  it('refuses to use an element set outside its validity window instead of extrapolating', () => {
    const { clock, transport, feed, sendAttitude } = setup();
    clock.ms = TLE.epochMs + 5 * 86_400_000;
    transport.connection('connected');
    sendAttitude(clock.ms - 1000);
    expect(feed.status()).toMatchObject({ state: 'unavailable', orbit: { state: 'expired' } });
    expect(feed.status().counters.attitudeSamples).toBe(1);
    expect(feed.status().counters.orbitUnavailable).toBe(1);
  });

  it('goes stale when samples stop, and MissionState reports it', () => {
    const { clock, transport, feed, manager, sendAttitude, et } = setup();
    transport.connection('connected');
    sendAttitude(clock.ms - 1000);
    clock.ms += 30_000;
    expect(feed.status()).toMatchObject({ state: 'stale' });
    const a = manager.availability('ISS-LIVE', 'attitude', et(clock.ms));
    expect(a).toMatchObject({ available: false, reason: 'stale' });
  });

  it('disconnect, reconnect and a replayed snapshot: unavailable while down, and old values are not shown as new', () => {
    const { clock, transport, feed, manager, sendAttitude, et } = setup();
    transport.connection('connected');
    const first = clock.ms - 1000;
    sendAttitude(first);
    transport.connection('disconnected');
    expect(feed.status().state).toBe('disconnected');
    expect(manager.availability('ISS-LIVE', 'attitude', et(first + 2000))).toMatchObject({ available: false, reason: 'disconnected' });

    clock.ms += 60_000;
    transport.connection('connected');
    // A MERGE subscription replays the last values with their old timestamps.
    sendAttitude(first);
    expect(feed.status().counters.attitudeSamples).toBe(1);
    expect(feed.status().state).toBe('stale'); // the replayed snapshot was refused; the last accepted sample is a minute old
    sendAttitude(clock.ms - 500);
    expect(feed.status().state).toBe('live');
    expect(manager.availability('ISS-LIVE', 'attitude', et(clock.ms - 500)).available).toBe(true);
    // The gap between is not bridged.
    expect(manager.availability('ISS-LIVE', 'attitude', et(clock.ms - 30_000)).available).toBe(false);
  });

  it('partial components before a disconnect are not combined with those after reconnect', () => {
    const { clock, transport, feed, sendAttitude } = setup();
    transport.connection('connected');
    transport.item({ item: 'A', value: 1, sourceTimeMs: clock.ms - 800 });
    transport.item({ item: 'B', value: 0, sourceTimeMs: clock.ms - 800 });
    transport.connection('disconnected');
    transport.connection('connected');
    transport.item({ item: 'C', value: 0, sourceTimeMs: clock.ms - 800 });
    transport.item({ item: 'D', value: 0, sourceTimeMs: clock.ms - 800 });
    expect(feed.status().counters.attitudeSamples).toBe(0);
    sendAttitude(clock.ms - 700);
    expect(feed.status().counters.attitudeSamples).toBe(1);
  });

  it('a historical simulation time never receives live data', () => {
    const { clock, transport, manager, sendAttitude, et } = setup();
    transport.connection('connected');
    sendAttitude(clock.ms - 1000);
    const historical = et(Date.UTC(2026, 2, 31, 12));
    expect(manager.availability('ISS-LIVE', 'attitude', historical)).toMatchObject({ available: false, reason: 'before-coverage' });
    expect(manager.evaluatePosition('ISS-LIVE', historical).position.every(Number.isNaN)).toBe(true);
  });

  it('removing the source stops the transport and later items change nothing', () => {
    const { clock, transport, feed, manager, sendAttitude } = setup();
    transport.connection('connected');
    sendAttitude(clock.ms - 1000);
    expect(manager.removeSource('ISS-LIVE')).toBe(true);
    expect(transport.stops).toBe(1);
    expect(transport.active).toBe(false);
    sendAttitude(clock.ms - 500);
    expect(feed.status().counters.attitudeSamples).toBe(1);
    expect(feed.status().state).toBe('unavailable');
  });

  it('holds the source disconnected until the transport really connects', () => {
    const { clock, transport, manager, sendAttitude } = setup();
    // MissionState marks a subscribed source live; the adapter immediately corrects that.
    expect(manager.status('ISS-LIVE')?.connection).toBe('disconnected');
    transport.connection('connecting');
    expect(manager.status('ISS-LIVE')?.connection).toBe('disconnected');
    transport.connection('connected');
    expect(manager.status('ISS-LIVE')?.connection).toBe('live');
    sendAttitude(clock.ms - 100);
  });

  it('a scalar-last telemetry order is reordered, not misread', () => {
    const { clock, transport, manager, et } = setup({ ...CONFIG, attitude: { ...CONFIG.attitude, order: 'scalar-last', convention: { reference: 'inertial', direction: 'reference-to-body' } } });
    transport.connection('connected');
    const t = clock.ms - 1000;
    [0.5, 0.5, 0.5, 0.5].forEach((v, i) => transport.item({ item: ITEMS[i], value: v, sourceTimeMs: t }));
    // (x,y,z,w) = (0,0,0,1) must be identity.
    const t2 = clock.ms - 500;
    [0, 0, 0, 1].forEach((v, i) => transport.item({ item: ITEMS[i], value: v, sourceTimeMs: t2 }));
    expect(manager.evaluateAttitude('ISS-LIVE', et(t2))).toEqual([1, 0, 0, 0]);
    expect(manager.evaluateAttitude('ISS-LIVE', et(t))).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe('live joint source', () => {
  const sendJoints = (transport: ReplayTransport, srcMs: number, deg: Record<string, number> = { ...Object.fromEntries(ALL_J.map((i) => [i, 0])), J_S4: 10, J_P4: 20, J_S4_01: 30 }) =>
    Object.entries(deg).forEach(([item, value]) => transport.item({ item, value, sourceTimeMs: srcMs }));

  it('converts units, applies the configured offset, and drives only near the sample epoch', () => {
    const { clock, transport, feed, et } = setup();
    transport.connection('connected');
    sendJoints(transport, clock.ms - 1000);
    const a = feed.jointSource.anglesAt(et(clock.ms - 1000))!;
    expect(a.truss!.S4).toBeCloseTo((10 * Math.PI) / 180 + 0.1, 12);
    expect(a.truss!.P4).toBeCloseTo((20 * Math.PI) / 180, 12);
    expect(a.arrays!.S4_01).toBeCloseTo((30 * Math.PI) / 180, 12);
    // A seek elsewhere (history or the future) is not live.
    expect(feed.jointSource.anglesAt(et(Date.UTC(2026, 2, 31, 12)))).toBeUndefined();
    expect(feed.jointSource.anglesAt(et(clock.ms + 3600_000))).toBeUndefined();
    expect(feed.status().joints.state).toBe('live');
  });

  it('is unavailable when stale or disconnected, never holding an old angle', () => {
    const { clock, transport, feed, et } = setup();
    transport.connection('connected');
    sendJoints(transport, clock.ms - 1000);
    const e = et(clock.ms - 1000);
    expect(feed.jointSource.anglesAt(e)).toBeDefined();
    transport.connection('disconnected');
    expect(feed.jointSource.anglesAt(e)).toBeUndefined();
    transport.connection('connected');
    clock.ms += 20_000;
    expect(feed.jointSource.anglesAt(e)).toBeUndefined();
    expect(feed.status().joints.state).toBe('stale');
  });

  it('does not mix joint components from different times', () => {
    const { clock, transport, feed, et } = setup();
    transport.connection('connected');
    transport.item({ item: 'J_S4', value: 10, sourceTimeMs: clock.ms - 9000 });
    transport.item({ item: 'J_P4', value: 20, sourceTimeMs: clock.ms - 1000 });
    transport.item({ item: 'J_S4_01', value: 30, sourceTimeMs: clock.ms - 1000 });
    expect(feed.jointSource.anglesAt(et(clock.ms - 1000))).toBeUndefined();
  });

  it('a feed configured for only some joints reports incomplete and applies none of them', () => {
    const partial: LiveIssConfig = { ...CONFIG, joints: { ...CONFIG.joints!, items: { 'truss:S4': 'J_S4', 'array:S4_01': 'J_S4_01' } } };
    const { clock, transport, feed, et } = setup(partial);
    transport.connection('connected');
    sendJoints(transport, clock.ms - 1000, { J_S4: 10, J_S4_01: 30 });
    expect(feed.jointSource.status(et(clock.ms - 1000))).toBe('incomplete');
    expect(feed.jointSource.anglesAt(et(clock.ms - 1000))).toBeUndefined();
    expect(feed.status().joints).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('only some joints') });
  });

  it('without configured channels the joints are unavailable, with that stated', () => {
    const { feed } = setup({ attitude: CONFIG.attitude });
    expect(feed.status().joints).toEqual({ state: 'unavailable', reason: 'Solar-array channels are not configured' });
    expect(feed.jointSource.anglesAt(0)).toBeUndefined();
  });
});

describe('unverified mappings are not applied by default', () => {
  const build = (accept: boolean) => {
    const clock = { ms: TLE.epochMs + 3_600_000 };
    const transport = new ReplayTransport();
    const feed = createLiveIssFeed({ config: CONFIG, transport, now: () => clock.ms, acceptUnverified: accept });
    feed.setOrbit(TLE);
    const manager = new MissionStateManager({ now: () => clock.ms });
    manager.addSource(feed.source);
    transport.connection('connected');
    ITEMS.forEach((item, i) => transport.item({ item, value: [1, 0, 0, 0][i], sourceTimeMs: clock.ms - 500 }));
    ALL_J.forEach((item) => transport.item({ item, value: 10, sourceTimeMs: clock.ms - 500 }));
    return { clock, feed, manager };
  };
  const et = (ms: number) => etFromDate(new Date(ms));

  it('publishes nothing to MissionState and gives the rig no angles, saying why', () => {
    const { clock, feed, manager } = build(false);
    expect(manager.availability('ISS-LIVE', 'attitude', et(clock.ms - 500)).available).toBe(false);
    expect(feed.status()).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('unverified'), joints: { state: 'unavailable', reason: expect.stringContaining('unverified') } });
    expect(feed.jointSource.anglesAt(et(clock.ms - 500))).toBeUndefined();
    expect(feed.jointSource.status(et(clock.ms - 500))).toBe('unverified');
  });

  it('the explicit experiment opt-in applies them and labels the provenance unverified', () => {
    const { clock, feed, manager } = build(true);
    const a = manager.availability('ISS-LIVE', 'attitude', et(clock.ms - 500));
    expect(a.available).toBe(true);
    expect(a.provenance?.source).toContain('UNVERIFIED');
    expect(feed.jointSource.anglesAt(et(clock.ms - 500))).toBeDefined();
  });

  it('verified configurations apply without the opt-in', () => {
    const clock = { ms: TLE.epochMs + 3_600_000 };
    const transport = new ReplayTransport();
    const feed = createLiveIssFeed({ config: { ...CONFIG, attitude: { ...CONFIG.attitude, verification: 'verified' }, joints: { ...CONFIG.joints!, verification: 'verified' } }, transport, now: () => clock.ms });
    feed.setOrbit(TLE);
    new MissionStateManager({ now: () => clock.ms }).addSource(feed.source);
    transport.connection('connected');
    ITEMS.forEach((item, i) => transport.item({ item, value: [1, 0, 0, 0][i], sourceTimeMs: clock.ms - 500 }));
    ALL_J.forEach((item) => transport.item({ item, value: 10, sourceTimeMs: clock.ms - 500 }));
    expect(feed.status().state).toBe('live');
    expect(feed.jointSource.status(etFromDate(new Date(clock.ms - 500)))).toBe('live');
  });
});

describe('joint status through disconnect', () => {
  it('reports unavailable/disconnected, never live, after the feed drops', () => {
    const { clock, transport, feed, et } = setup();
    transport.connection('connected');
    ALL_J.forEach((item) => transport.item({ item, value: 10, sourceTimeMs: clock.ms - 500 }));
    const e = et(clock.ms - 500);
    expect(feed.status().joints.state).toBe('live');
    transport.connection('disconnected');
    expect(feed.status().joints).toMatchObject({ state: 'unavailable' });
    expect(feed.jointSource.status(e)).toBe('disconnected');
  });
});
