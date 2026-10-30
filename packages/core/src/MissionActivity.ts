import { etFromCalendarString } from './time.js';

export const ACTIVITY_KINDS = ['flight', 'drive', 'hop', 'descent', 'landing', 'phase', 'other'] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];
export interface ActivityProvenance {
  source: string;
  version: string;
  authority: 'observed' | 'authored' | 'estimated' | 'inferred';
  limitations: string;
  /** Bounds enclose a reported operation; they are not its actual duration. */
  timing: 'exact' | 'estimated' | 'bounded';
  uncertaintySeconds?: number;
}
export interface MissionActivity {
  version: 1;
  /** Retained for discovery but unavailable for selection/seeking when false. */
  enabled?: boolean;
  id: string;
  name: string;
  kind: ActivityKind;
  vehicle: string;
  body: string;
  temporality: 'interval' | 'instant';
  /** Normalized seconds past J2000 TDB, in the shared simulation clock. */
  start: number;
  end: number;
  provenance: ActivityProvenance;
  mission?: string;
  site?: string;
  parent?: string;
  group?: string;
  references?: { trajectory?: string; sourceSegment?: string; location?: string; viewpoint?: string; objects?: string[] };
}
export type MissionActivitySpec = Omit<MissionActivity, 'start' | 'end'> & (
  { timeSystem: 'ET'; start: number; end: number } |
  { timeSystem: 'UTC'; start: string; end: string }
);
export interface ActivityFilter { vehicle?: string; kind?: ActivityKind }
export const compareActivities = (a: MissionActivity, b: MissionActivity): number =>
  a.start - b.start || a.end - b.end || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function utcTimestamp(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1] && hour < 24 && minute < 60 && second <= 60;
}

/** Strict, atomic validation. An invalid list never becomes a plausible partial mission. */
export function parseMissionActivities(input: unknown, utcToEt = etFromCalendarString): MissionActivity[] {
  if (!Array.isArray(input)) throw new Error('activities must be an array');
  const ids = new Set<string>();
  return input.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('activity must be an object');
    const a = raw as MissionActivitySpec;
    const fail = (message: string): never => { throw new Error(`activity ${a.id ?? '(missing id)'}: ${message}`); };
    const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
    for (const key of ['id', 'name', 'vehicle', 'body'] as const) if (!nonempty(a[key])) fail(`${key} required`);
    if (a.version !== 1) fail('unsupported version');
    if (a.enabled !== undefined && typeof a.enabled !== 'boolean') fail('invalid enabled flag');
    if (ids.has(a.id)) fail('duplicate id');
    ids.add(a.id);
    if (!ACTIVITY_KINDS.includes(a.kind)) fail('invalid kind');
    if (a.temporality !== 'instant' && a.temporality !== 'interval') fail('invalid temporality');
    const p = a.provenance;
    if (!p || !nonempty(p.source) || !nonempty(p.version) || !nonempty(p.limitations) ||
      !['observed', 'authored', 'estimated', 'inferred'].includes(p.authority) ||
      !['exact', 'estimated', 'bounded'].includes(p.timing)) fail('provenance required (source, version, authority, timing, limitations)');
    if (p.uncertaintySeconds !== undefined && (!Number.isFinite(p.uncertaintySeconds) || p.uncertaintySeconds < 0)) fail('invalid uncertainty');
    for (const key of ['mission', 'site', 'parent', 'group'] as const) if (a[key] !== undefined && !nonempty(a[key])) fail(`invalid ${key}`);
    if (a.references !== undefined) {
      if (!a.references || typeof a.references !== 'object' || Array.isArray(a.references)) fail('invalid references');
      for (const key of ['trajectory', 'sourceSegment', 'location', 'viewpoint'] as const) if (a.references[key] !== undefined && !nonempty(a.references[key])) fail(`invalid reference ${key}`);
      if (a.references.objects !== undefined && (!Array.isArray(a.references.objects) || !a.references.objects.every(nonempty))) fail('invalid object references');
    }
    let start: number, end: number;
    if (a.timeSystem === 'ET' && typeof a.start === 'number' && typeof a.end === 'number') {
      start = a.start; end = a.end;
    } else if (a.timeSystem === 'UTC' && typeof a.start === 'string' && typeof a.end === 'string' &&
      utcTimestamp(a.start) && utcTimestamp(a.end)) {
      start = utcToEt(a.start); end = utcToEt(a.end);
    } else return fail('explicit ET numbers or UTC ISO timestamps ending in Z required');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || (a.temporality === 'instant' ? end !== start : end === start)) fail('invalid time bounds');
    const { timeSystem: _system, ...record } = a;
    return { ...record, start, end, provenance: { ...p }, references: a.references ? { ...a.references, objects: a.references.objects?.slice() } : undefined } as MissionActivity;
  }).sort(compareActivities);
}

/** In-process catalog/provider boundary. Replacing an owner also removes its missing records. */
export class MissionActivityStore {
  private owners = new Map<string, readonly MissionActivity[]>();
  private records: readonly MissionActivity[] = [];
  private declared = new Set<string>();
  private listeners = new Set<() => void>();
  get available(): boolean { return this.declared.size > 0; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private byId = new Map<string, MissionActivity>();
  replace(owner: string, records: readonly MissionActivity[], declared = true): void {
    const next = new Map(this.owners);
    const validated = parseMissionActivities(records.map(a => ({ ...a, timeSystem: 'ET' })));
    for (const a of validated) {
      Object.freeze(a.provenance);
      if (a.references) { if (a.references.objects) Object.freeze(a.references.objects); Object.freeze(a.references); }
      Object.freeze(a);
    }
    next.set(owner, Object.freeze(validated));
    const all = [...next.values()].flat();
    const ids = new Set<string>();
    for (const a of all) { if (ids.has(a.id)) throw new Error(`duplicate activity id: ${a.id}`); ids.add(a.id); }
    this.owners = next;
    this.records = Object.freeze(all.sort(compareActivities));
    this.byId = new Map(this.records.map(a => [a.id, a]));
    if (declared) this.declared.add(owner); else this.declared.delete(owner);
    for (const listener of this.listeners) listener();
  }
  list(filter: ActivityFilter = {}): readonly MissionActivity[] {
    if (!filter.vehicle && !filter.kind) return this.records;
    return this.records.filter(a => (!filter.vehicle || a.vehicle === filter.vehicle) && (!filter.kind || a.kind === filter.kind));
  }
  get(id: string): MissionActivity | undefined { return this.byId.get(id); }
  clear(): void { this.owners.clear(); this.declared.clear(); this.records = []; this.byId.clear(); for (const listener of this.listeners) listener(); }
}

/** Order is start, end, stable ID. Selected IDs disambiguate overlap/ties.
 * Without selection, next is strictly after now; previous is at/before now. */
export function adjacentActivity(items: readonly MissionActivity[], et: number, direction: -1 | 1, selectedId?: string | null): MissionActivity | undefined {
  const index = selectedId ? items.findIndex(a => a.id === selectedId) : -1;
  if (index >= 0) return items[index + direction];
  let lo = 0, hi = items.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (items[mid].start <= et) lo = mid + 1; else hi = mid; }
  return items[direction === 1 ? lo : lo - 1];
}

export function activityWindow(a: MissionActivity): [number, number] {
  const padding = Math.max(1, (a.end - a.start) * .1);
  return [a.start - padding, a.end + padding];
}
