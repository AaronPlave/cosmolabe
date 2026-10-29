import type { GeometryEvent, MissionActivity } from '@cosmolabe/core';

/** Shared event inspector vocabulary; activity metadata remains authoritative. */
export function activityEvent(a: MissionActivity): GeometryEvent {
  const base = { id: a.id, queryId: `activity:${a.vehicle}:${a.kind}`, kind: 'mission-activity',
    label: `${a.vehicle} ${a.name}`, state: a.provenance.timing, bodies: { observer: a.vehicle }, primaryRole: 'observer' as const };
  return a.temporality === 'instant' ? { ...base, temporality: 'instant', et: a.start } :
    { ...base, temporality: 'interval', start: a.start, end: a.end };
}

export function activitySeries(records: readonly MissionActivity[]) {
  const groups = new Map<string, { body: string; label: string; items: MissionActivity[] }>();
  for (const a of records) {
    const key = `${a.vehicle}:${a.kind}`;
    if (!groups.has(key)) groups.set(key, { body: a.vehicle, label: a.kind, items: [] });
    groups.get(key)!.items.push(a);
  }
  return [...groups.values()];
}

/** Greedy overlap rows, bounded to 4 for density; chooser retains every record. */
export function activityLayout(items: readonly MissionActivity[]) {
  const ends: number[] = [];
  return items.map(item => {
    let row = ends.findIndex(end => end < item.start);
    if (row < 0) row = ends.length;
    row = Math.min(3, row);
    ends[row] = item.end;
    return { item, row };
  });
}

/** Window/record changes only. Bound DOM density; exact navigation stays in the chooser. */
export function visibleActivityMarks(layout: ReturnType<typeof activityLayout>, min: number, max: number, limit = 200) {
  const visible = layout.filter(({ item }) => item.end >= min && item.start <= max);
  if (visible.length <= limit) return visible.map(m => ({ ...m, count: 1 }));
  const bins = new Map<number, { item: MissionActivity; row: number; count: number }>();
  for (const m of visible) {
    const bin = Math.max(0, Math.min(limit - 1, Math.floor((m.item.start - min) / (max - min) * limit)));
    const entry = bins.get(bin);
    if (entry) entry.count++; else bins.set(bin, { ...m, count: 1 });
  }
  return [...bins.values()];
}
