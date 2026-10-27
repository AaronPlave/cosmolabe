import { describe, expect, it } from 'vitest';
import { Body, CompositeTrajectory, FixedPointTrajectory, InterpolatedStatesTrajectory } from '@cosmolabe/core';
import { adjacentTrajectoryInterval, trajectoryIntervals, trajectoryIntervalWindow } from '../trajectory-timeline';

function body(optIn = true) {
  const sampled = (start: number, end: number) => new InterpolatedStatesTrajectory([
    { et: start, position: [1, 0, 0], velocity: [0, 0, 0] },
    { et: end, position: [1, 1, 0], velocity: [0, 0, 0] },
  ]);
  return new Body({ name: 'Ingenuity', trajectoryPlot: optIn ? { timelineLabel: 'Flight' } : {}, trajectory: new CompositeTrajectory([
    { startTime: 10, endTime: 1000, trajectory: sampled(10, 50) },
    { startTime: 1000, endTime: 2000, trajectory: sampled(1000, 1100) },
    { startTime: 2000, endTime: 3000, trajectory: new FixedPointTrajectory([1, 0, 0]), showLine: false },
  ]) });
}

describe('sampled trajectory timeline', () => {
  it('uses sampled bounds, excluding parked arc routing and hidden landed arcs', () => {
    expect(trajectoryIntervals([body()])).toEqual([
      { id: 'Ingenuity:0', body: 'Ingenuity', label: 'Flight 1', start: 10, end: 50 },
      { id: 'Ingenuity:1', body: 'Ingenuity', label: 'Flight 2', start: 1000, end: 1100 },
    ]);
    expect(trajectoryIntervals([body(false)])).toEqual([]);
  });
  it('navigates from a flight, a parked gap and mission boundaries without wrapping', () => {
    const items = trajectoryIntervals([body()]);
    expect(adjacentTrajectoryInterval(items, 20, -1)).toBeUndefined();
    expect(adjacentTrajectoryInterval(items, 20, 1)).toBe(items[1]);
    expect(adjacentTrajectoryInterval(items, 500, -1)).toBe(items[0]);
    expect(adjacentTrajectoryInterval(items, 500, 1)).toBe(items[1]);
    expect(adjacentTrajectoryInterval(items, 1050, -1)).toBe(items[0]);
    expect(adjacentTrajectoryInterval(items, 1050, 1)).toBeUndefined();
    expect(adjacentTrajectoryInterval(items, 0, 1)).toBe(items[0]);
    expect(adjacentTrajectoryInterval(items, 3000, -1)).toBe(items[1]);
    expect(trajectoryIntervalWindow(items[0])).toEqual([6, 54]);
  });
});
