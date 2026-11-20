import type { GeometryEvent, MissionActivity } from '@cosmolabe/core';

/** Shared event inspector vocabulary; activity metadata remains authoritative. */
export function activityEvent(a: MissionActivity): GeometryEvent {
  // The first object the activity names besides its vehicle (an imaged site, a
  // ground station) is what it is about, so the scene highlights both.
  const target = a.references?.objects?.find(o => o !== a.vehicle);
  const base = { id: a.id, queryId: `activity:${a.vehicle}:${a.kind}`, kind: 'mission-activity',
    label: `${a.vehicle} ${a.name}`, state: a.provenance.timing, bodies: { observer: a.vehicle, ...(target ? { target } : {}) }, primaryRole: 'observer' as const };
  return a.temporality === 'instant' ? { ...base, temporality: 'instant', et: a.start } :
    { ...base, temporality: 'interval', start: a.start, end: a.end };
}

/** The lane an activity belongs to: its group when it names one, else its kind. */
export const activityLane = (a: MissionActivity) => a.group ?? a.kind;

/** One lane per vehicle and group (or kind), in order of first appearance. */
export function activitySeries(records: readonly MissionActivity[]) {
  const groups = new Map<string, { body: string; label: string; items: MissionActivity[] }>();
  for (const a of records) {
    const key = `${a.vehicle}:${activityLane(a)}`;
    if (!groups.has(key)) groups.set(key, { body: a.vehicle, label: activityLane(a), items: [] });
    groups.get(key)!.items.push(a);
  }
  return [...groups.values()];
}

/**
 * The activities a one-row summary shows: operations, leaving out continuous
 * phases (an attitude mode covering every moment) unless they are all there is.
 */
export function summaryActivities(records: readonly MissionActivity[]): MissionActivity[] {
  const operations = records.filter(a => a.kind !== 'phase');
  return operations.length ? operations : [...records];
}

const LANE_COLORS = ['#b69bd3', '#72b7d8', '#e0b86a', '#71b896', '#d88c72'];
/** Continuous phases read as muted context; each operations lane keeps one color wherever it appears. */
export function laneColor(items: readonly MissionActivity[], label: string): string {
  if (items.length && items.every(a => a.kind === 'phase')) return '#8a96a8';
  let h = 0;
  for (const c of label) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return LANE_COLORS[h % LANE_COLORS.length];
}

/** Greedy overlap rows, bounded to 4 for density; chooser retains every record. */
export function activityLayout(items: readonly MissionActivity[]) {
  const ends: number[] = [];
  return items.map(item => {
    let row = ends.findIndex(end => end < item.start);
    if (row < 0) row = ends.length;
    row = Math.min(3, row);
    ends[row] = Math.max(ends[row] ?? -Infinity, item.end);
    return { item, row };
  });
}

interface ActivityMark {
  item: MissionActivity; row: number; count: number; windowStart: number; windowEnd: number;
  /** Small overlapping groups open their exact members; dense bins zoom. */
  members?: MissionActivity[];
}

/** Window/record changes only. Bound DOM density; exact navigation stays in the chooser. */
export function visibleActivityMarks(layout: ReturnType<typeof activityLayout>, min: number, max: number, limit = 200) {
  const visible = layout.filter(({ item }) => item.end >= min && item.start <= max);
  if (visible.length <= limit) {
    const marks: ActivityMark[] = [];
    let overflow: ActivityMark | undefined;
    for (const m of visible) {
      if (m.row === 3 && overflow && m.item.start <= overflow.windowEnd) {
        overflow.count++;
        overflow.windowEnd = Math.max(overflow.windowEnd, m.item.end);
        overflow.members!.push(m.item);
      } else {
        const mark = { ...m, count: 1, windowStart: m.item.start, windowEnd: m.item.end, members: [m.item] };
        marks.push(mark);
        if (m.row === 3) overflow = mark;
      }
    }
    return marks;
  }
  const bins = new Map<number, ActivityMark>();
  for (const m of visible) {
    const bin = Math.max(0, Math.min(limit - 1, Math.floor((m.item.start - min) / (max - min) * limit)));
    const entry = bins.get(bin);
    if (entry) entry.count++; else bins.set(bin, { ...m, count: 1, windowStart: min + bin / limit * (max - min), windowEnd: min + (bin + 1) / limit * (max - min) });
  }
  return [...bins.values()];
}
