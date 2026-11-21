import { expect, it } from 'vitest';
import { Universe } from '../Universe.js';
import { Body } from '../Body.js';
import { CompositeTrajectory } from '../trajectories/CompositeTrajectory.js';
import { FixedPointTrajectory } from '../trajectories/FixedPoint.js';
import { InterpolatedStatesTrajectory } from '../trajectories/InterpolatedStates.js';
import { oemCoverage, oemToStateRecords } from '../trajectories/OemAdapter.js';
import { parseOem } from '@cosmolabe/interop';

// Two explicitly declared OEM segments, not a guessed cadence threshold.
const segment = (start: number, end: number) => `META_START
CENTER_NAME = Earth
REF_FRAME = J2000
TIME_SYSTEM = TDB
START_TIME = 2000-01-01T12:00:${String(start).padStart(2, '0')}
STOP_TIME = 2000-01-01T12:00:${String(end).padStart(2, '0')}
META_STOP
2000-01-01T12:00:${String(start).padStart(2, '0')} ${start + 100} 0 0 1 0 0
2000-01-01T12:00:${String(end).padStart(2, '0')} ${end + 100} 0 0 1 0 0`;
const oem = () => parseOem(`CCSDS_OEM_VERS = 2.0\n${segment(0, 10)}\n${segment(20, 30)}`);
const time = (s: string) => Number(s.split(':').at(-1)!.split(' ')[0]);

it('keeps segment metadata and bounds, with no invented interpolation through the gap', () => {
  const parsed = oem();
  expect(parsed.segments).toHaveLength(2);
  expect(parsed.metadata.startTime).toContain('12:00:00');
  const trajectory = new InterpolatedStatesTrajectory(oemToStateRecords(parsed, time), { coverage: oemCoverage(parsed, time) });
  for (const et of [0, 5, 10, 20, 25, 30]) {
    expect(trajectory.availabilityAt(et).available).toBe(true);
    expect(trajectory.stateAt(et).position[0]).toBeCloseTo(et + 100);
  }
  for (const [et, reason] of [[-1, 'before-coverage'], [15, 'gap'], [31, 'after-coverage']] as const) {
    expect(trajectory.availabilityAt(et)).toMatchObject({ available: false, reason });
    expect(trajectory.stateAt(et).position.every(Number.isNaN)).toBe(true);
  }
  expect(trajectory.displayStateAt(-1).position[0]).toBe(100);
  expect(trajectory.displayStateAt(31).position[0]).toBe(130);
  expect(trajectory.displayStateAt(15).position.every(Number.isNaN)).toBe(true);
});

it('intersects declared usable limits with records and refuses incompatible segments', () => {
  const parsed = parseOem(`CCSDS_OEM_VERS = 2.0\n${segment(0, 10).replace('META_STOP', 'USEABLE_START_TIME = 2000-01-01T12:00:02\nUSEABLE_STOP_TIME = 2000-01-01T12:00:08\nMETA_STOP')}`);
  expect(oemCoverage(parsed, time)).toEqual([{ start: 2, end: 8 }]);
  const mixed = parseOem(`CCSDS_OEM_VERS = 2.0\n${segment(0, 10)}\n${segment(20, 30).replace('J2000', 'TEME')}`);
  expect(() => oemToStateRecords(mixed, time)).toThrow(/different refFrame/);
});

it('scientific world/state reads reject coverage and dependency gaps while display endpoint holds remain explicit', () => {
  const u = new Universe();
  const parsed = oem();
  const trajectory = new InterpolatedStatesTrajectory(oemToStateRecords(parsed, time), { coverage: oemCoverage(parsed, time) });
  u.addBody(new Body({ name: 'Earth', trajectory: new FixedPointTrajectory([0, 0, 0]) }));
  u.addBody(new Body({ name: 'Probe', parentName: 'Earth', trajectory }));
  u.addBody(new Body({ name: 'Instrument', parentName: 'Probe', trajectory: new FixedPointTrajectory([1, 0, 0]) }));
  for (const et of [-1, 15, 31]) {
    expect(u.stateIn('Probe', et).position).toBeNull();
    expect(u.stateAvailability('Probe', et).position.available).toBe(false);
    expect(u.absolutePositionOf('Instrument', et).every(Number.isNaN)).toBe(true);
    expect(u.stateIn('Earth', et, { center: 'Probe' }).position).toBeNull();
  }
  expect(u.absolutePositionOf('Probe', -1, 'display')).toEqual([100, 0, 0]);
  expect(u.absolutePositionOf('Instrument', 31, 'display')).toEqual([131, 0, 0]);
  expect(u.stateIn('Probe', 5).position).toEqual([105, 0, 0]);
});

it('retains display-only holding through composite children', () => {
  const parsed = oem();
  const child = new InterpolatedStatesTrajectory(oemToStateRecords(parsed, time), { coverage: oemCoverage(parsed, time) });
  const composite = new CompositeTrajectory([{ startTime: 0, endTime: 30, trajectory: child }]);
  expect(composite.stateAt(-1).position.every(Number.isNaN)).toBe(true);
  expect(composite.displayStateAt(-1).position).toEqual([100, 0, 0]);
  expect(composite.stateAt(15).position.every(Number.isNaN)).toBe(true);
  expect(composite.displayStateAt(15).position.every(Number.isNaN)).toBe(true);
});
