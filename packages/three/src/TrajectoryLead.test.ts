import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Body, type Trajectory } from '@cosmolabe/core';
import { TrajectoryLine } from './TrajectoryLine.js';
import { leadDashPeriod, leadFade, resolveLeadWindows, type LeadPolicy } from './TrajectoryLead.js';

const DAY = 86400;
const POLICY: LeadPolicy = { maxContinuous: 10 * DAY, contextPad: 3600 };
const OPEN = { start: -Infinity, end: Infinity };

describe('resolveLeadWindows', () => {
  it('draws nothing without requests', () => {
    expect(resolveLeadWindows(0, [], OPEN, POLICY)).toEqual([]);
  });

  it('draws a continuous lead of the requested duration from the playhead', () => {
    expect(resolveLeadWindows(100, [{ duration: DAY }], OPEN, POLICY)).toEqual([
      { start: 100, end: 100 + DAY, kind: 'continuous' },
    ]);
  });

  it('extends the continuous lead through a near target, plus context', () => {
    const [w] = resolveLeadWindows(0, [{ target: { start: 2 * DAY, end: 2 * DAY } }], OPEN, POLICY);
    expect(w).toEqual({ start: 0, end: 2 * DAY + 3600, kind: 'continuous' });
  });

  it('shows an excerpt around a distant target instead of every intervening segment', () => {
    const t = 400 * DAY;
    const windows = resolveLeadWindows(0, [{ duration: DAY }, { target: { start: t, end: t } }], OPEN, POLICY);
    expect(windows).toEqual([
      { start: 0, end: DAY, kind: 'continuous' },
      { start: t - 3600, end: t + 3600, kind: 'context' },
    ]);
  });

  it('caps a long interval that starts within reach at the continuous reach', () => {
    const windows = resolveLeadWindows(0, [{ target: { start: DAY, end: 100 * DAY } }], OPEN, POLICY);
    expect(windows).toEqual([{ start: 0, end: 10 * DAY, kind: 'continuous' }]);
  });

  it('ignores targets that are already behind the playhead', () => {
    expect(resolveLeadWindows(10 * DAY, [{ target: { start: DAY, end: 2 * DAY } }], OPEN, POLICY)).toEqual([]);
  });

  it('reaches to the end of an interval the playhead is inside', () => {
    const [w] = resolveLeadWindows(5, [{ target: { start: 0, end: 1000 } }], OPEN, { ...POLICY, contextPad: 0 });
    expect(w.start).toBe(5);
    expect(w.end).toBe(1250); // end + 25% of the interval as context
  });

  it('never leaves coverage: no extrapolation past the end of data', () => {
    const windows = resolveLeadWindows(0, [{ duration: 10 * DAY }], { start: -Infinity, end: 3 * DAY }, POLICY);
    expect(windows).toEqual([{ start: 0, end: 3 * DAY, kind: 'continuous' }]);
    expect(resolveLeadWindows(5 * DAY, [{ duration: DAY }], { start: 0, end: 3 * DAY }, POLICY)).toEqual([]);
  });

  it('starts a future arc\'s lead at the arc start, not the playhead', () => {
    const windows = resolveLeadWindows(0, [{ target: { start: 2 * DAY, end: 2 * DAY } }], { start: DAY, end: 5 * DAY }, POLICY);
    expect(windows).toEqual([{ start: DAY, end: 2 * DAY + 3600, kind: 'continuous' }]);
  });

  it('merges overlapping windows from independent requests', () => {
    const t = 400 * DAY;
    const windows = resolveLeadWindows(0, [
      { target: { start: t, end: t } },
      { target: { start: t + 1800, end: t + 1800 } },
    ], OPEN, POLICY);
    expect(windows).toEqual([{ start: t - 3600, end: t + 1800 + 3600, kind: 'context' }]);
  });
});

describe('lead styling', () => {
  it('snaps the dash period to a power of two', () => {
    const p = leadDashPeriod(DAY);
    expect(Math.log2(p) % 1).toBe(0);
    expect(leadDashPeriod(DAY * 1.1)).toBe(p);
  });

  it('dims a continuous lead away from the playhead, tapers context, and keeps targets full', () => {
    const cont = { start: 0, end: 100, kind: 'continuous' as const };
    expect(leadFade(0, cont, [])).toBe(1);
    expect(leadFade(100, cont, [])).toBeCloseTo(0.3);
    expect(leadFade(90, cont, [{ start: 80, end: 95 }])).toBe(1);
    const ctx = { start: 0, end: 100, kind: 'context' as const };
    expect(leadFade(0, ctx, [])).toBe(0);
    expect(leadFade(50, ctx, [])).toBe(1);
    expect(leadFade(100, ctx, [])).toBe(0);
  });
});

/** A circular orbit of radius 1000 km, period 1 day, covering [0, end]. */
function circular(end = Infinity): Trajectory {
  return {
    startTime: 0,
    endTime: Number.isFinite(end) ? end : undefined,
    stateAt(et: number) {
      if (et < 0 || et > end) return { position: [NaN, NaN, NaN], velocity: [NaN, NaN, NaN] };
      const a = (2 * Math.PI * et) / DAY;
      return { position: [1000 * Math.cos(a), 1000 * Math.sin(a), 0], velocity: [0, 0, 0] };
    },
  } as Trajectory;
}

function lineFor(trajectory: Trajectory, opts: ConstructorParameters<typeof TrajectoryLine>[1] = {}) {
  const body = new Body({ name: 'Sat', trajectory });
  return new TrajectoryLine(body, { trailDuration: DAY / 2, ...opts });
}

function trailTimes(line: TrajectoryLine): number {
  const trail = line.children.find((c) => c.name !== 'lead') as THREE.Line;
  return trail.geometry.drawRange.count;
}

describe('TrajectoryLine lead', () => {
  it('draws no future path by default', () => {
    const line = lineFor(circular());
    line.update(DAY, 1);
    expect(line.drawnLead().count).toBe(0);
    expect(trailTimes(line)).toBeGreaterThan(0);
  });

  it('draws the persistent leadDuration as dashed segments starting at the trail head', () => {
    const et = 2 * DAY;
    const line = lineFor(circular(), { leadDuration: DAY / 4 });
    line.update(et, 1);
    const lead = line.drawnLead();
    expect(lead.count).toBeGreaterThan(2);
    expect(lead.count % 2).toBe(0);
    expect(lead.times[0]).toBe(et);
    expect(lead.times[lead.count - 1]).toBeCloseTo(et + DAY / 4);
    // All lead vertices are in the future; the head coincides with the body.
    for (let i = 0; i < lead.count; i++) expect(lead.times[i]).toBeGreaterThanOrEqual(et);
    const a = (2 * Math.PI * et) / DAY;
    expect(lead.positions[0]).toBeCloseTo(1000 * Math.cos(a), 3);
    expect(lead.positions[1]).toBeCloseTo(1000 * Math.sin(a), 3);
    const material = (line.children.find((c) => c.name === 'lead') as THREE.LineSegments).material;
    expect(material).toBeInstanceOf(THREE.LineDashedMaterial);
  });

  it('keeps the trail historical: nothing on it is ahead of the playhead', () => {
    const et = 2 * DAY;
    const line = lineFor(circular(), { leadDuration: DAY / 4 });
    line.update(et, 1);
    const trail = line.children.find((c) => c.name !== 'lead') as THREE.Line;
    const pos = trail.geometry.getAttribute('position').array as Float32Array;
    const n = trail.geometry.drawRange.count;
    // The trail's last vertex is the body at the playhead, not a quarter orbit on.
    const a = (2 * Math.PI * et) / DAY;
    expect(pos[(n - 1) * 3]).toBeCloseTo(1000 * Math.cos(a), 2);
    expect(pos[(n - 1) * 3 + 1]).toBeCloseTo(1000 * Math.sin(a), 2);
  });

  it('reclassifies trail and lead as time moves, in either direction', () => {
    const line = lineFor(circular(), { leadDuration: DAY / 4 });
    line.update(2 * DAY, 1);
    line.update(3 * DAY, 1);
    expect(line.drawnLead().times[0]).toBe(3 * DAY);
    line.update(2.5 * DAY, 1);
    const lead = line.drawnLead();
    expect(lead.times[0]).toBe(2.5 * DAY);
    expect(lead.times[lead.count - 1]).toBeCloseTo(2.75 * DAY);
  });

  it('adds and withdraws keyed requests independently', () => {
    const line = lineFor(circular());
    line.setLeadRequest('preview', { target: { start: DAY + 3600, end: DAY + 3600 } });
    line.setLeadRequest('selection', { duration: 600 });
    line.update(DAY, 1);
    expect(line.leadWindows()[0].end).toBeGreaterThan(DAY + 3600);
    line.setLeadRequest('preview', null);
    line.update(DAY, 1);
    expect(line.leadWindows()).toEqual([{ start: DAY, end: DAY + 600, kind: 'continuous' }]);
    line.setLeadRequest('selection', null);
    line.update(DAY, 1);
    expect(line.drawnLead().count).toBe(0);
  });

  it('ends cleanly at the end of coverage', () => {
    const end = 2 * DAY + 3600;
    const line = lineFor(circular(end), { maxTime: end, leadDuration: DAY });
    line.update(2 * DAY, 1);
    const lead = line.drawnLead();
    expect(lead.times[lead.count - 1]).toBeLessThanOrEqual(end);
    for (let i = 0; i < lead.count * 3; i++) expect(Number.isNaN(lead.positions[i])).toBe(false);
  });

  it('can show a future arc\'s lead before the playhead reaches the arc', () => {
    const line = lineFor(circular(), { minTime: 2 * DAY, maxTime: 3 * DAY });
    line.update(DAY, 1);
    expect(line.visible).toBe(false);
    line.setLeadRequest('selection', { target: { start: 2 * DAY + 3600, end: 2 * DAY + 7200 } });
    line.update(DAY, 1);
    expect(line.visible).toBe(true);
    const lead = line.drawnLead();
    expect(lead.count).toBeGreaterThan(0);
    expect(lead.times[0]).toBeGreaterThanOrEqual(2 * DAY);
    expect(trailTimes(line)).toBeGreaterThanOrEqual(0);
    const trail = line.children.find((c) => c.name !== 'lead')!;
    expect(trail.visible).toBe(false);
  });
});

describe('TrajectoryLine drawn path (trail + lead)', () => {
  it('ends the trail range at the playhead and adds the lead to the drawn envelope', () => {
    const et = 2 * DAY;
    const line = lineFor(circular(), { leadDuration: DAY / 4 });
    line.update(et, 1);
    expect(line.visibleTimeRange(et)).toEqual([et - DAY / 4, et]);
    expect(line.drawnTimeRange(et)).toEqual([et - DAY / 4, et + DAY / 4]);
  });

  it('gives annotations one time-tagged path: trail, then each unbroken lead run', () => {
    const et = 2 * DAY;
    const far = et + 30 * DAY;
    const line = lineFor(circular(), { leadDuration: 3600, leadMaxContinuous: DAY, leadContextPad: 1800 });
    line.setLeadRequest('selection', { target: { start: far, end: far } });
    line.update(et, 1);
    const path = line.drawnPath();
    expect(path).toHaveLength(3);
    const [trail, near, excerpt] = path;
    expect(trail.times[trail.count - 1]).toBe(et);
    expect(near.times[0]).toBe(et);
    expect(near.times[near.count - 1]).toBeCloseTo(et + 3600);
    expect(excerpt.times[0]).toBeCloseTo(far - 1800);
    expect(excerpt.times[excerpt.count - 1]).toBeCloseTo(far + 1800);
    for (const run of path) {
      for (let i = 1; i < run.count; i++) expect(run.times[i]).toBeGreaterThanOrEqual(run.times[i - 1]);
    }
    // Drawn where the path is drawn, nothing in the gap between runs.
    expect(line.pathAlphaAt(et - 60, et)).toBeGreaterThan(0);
    expect(line.pathAlphaAt(et + 60, et)).toBeGreaterThan(0);
    expect(line.pathAlphaAt(et + 10 * DAY, et)).toBe(0);
    expect(line.pathAlphaAt(far, et)).toBe(1);
  });
});
