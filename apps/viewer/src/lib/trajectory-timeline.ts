/** @deprecated Migration-only arc adapter. Runtime activities come from catalog metadata. */
import { CompositeTrajectory, InterpolatedStatesTrajectory, type Body, type IntervalEvent } from '@cosmolabe/core';

export interface TrajectoryInterval {
  id: string;
  body: string;
  label: string;
  start: number;
  end: number;
}

export interface TrajectoryIntervalSeries {
  body: string;
  label: string;
  items: TrajectoryInterval[];
}

/** Shared timeline vocabulary, without manufacturing an event-search query.
 * Activities navigate the existing vehicle/path; they do not enable additional
 * historical 3D trajectory overlays as a side effect of showing the timeline. */
export function trajectoryIntervalEvent(item: TrajectoryInterval): IntervalEvent {
  return { id: item.id, queryId: `activity:${item.body}`, kind: 'mission-activity',
    temporality: 'interval', label: `${item.body} ${item.label}`,
    bodies: { observer: item.body }, primaryRole: 'observer', start: item.start, end: item.end };
}

/** Keep each vehicle's navigation independent, even when activities overlap. */
export function trajectoryIntervalSeries(bodies: readonly Body[]): TrajectoryIntervalSeries[] {
  return bodies.flatMap(body => {
    const items = trajectoryIntervals([body]);
    return items.length ? [{ body: body.name, label: body.trajectoryPlot!.timelineLabel!, items }] : [];
  });
}

/** Explicit opt-in only. Arc routing can include days parked after the last
 * sample, so its end is never a proxy for the end of an activity. */
export function trajectoryIntervals(bodies: readonly Body[]): TrajectoryInterval[] {
  return bodies.flatMap(body => {
    const label = body.trajectoryPlot?.timelineLabel;
    if (!label || !(body.trajectory instanceof CompositeTrajectory)) return [];
    return body.trajectory.arcs.flatMap((arc, index) => {
      if (!(arc.trajectory instanceof InterpolatedStatesTrajectory)) return [];
      const start = Math.max(arc.startTime, arc.trajectory.startTime);
      const end = Math.min(arc.endTime, arc.trajectory.endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
      return [{ id: `${body.name}:${index}`, body: body.name, label: `${label} ${index + 1}`, start, end }];
    });
  });
}

/** During a parked gap there is no active interval. Navigation is directional. */
export function adjacentTrajectoryInterval(intervals: readonly TrajectoryInterval[], et: number, direction: -1 | 1): TrajectoryInterval | undefined {
  const active = intervals.find(item => et >= item.start && et <= item.end);
  const anchor = active?.start ?? et;
  if (direction > 0) return intervals.find(item => item.start > anchor + 1e-4);
  return [...intervals].reverse().find(item => item.start < anchor - 1e-4);
}

export function trajectoryIntervalWindow(item: TrajectoryInterval): [number, number] {
  const padding = Math.max(1, (item.end - item.start) * .1);
  return [item.start - padding, item.end + padding];
}
