import type { SpatialEndpoint, SpatialRelationship, Universe } from '@cosmolabe/core';
import { ViewStateError } from '@cosmolabe/control';

/** Saved definitions, including temporarily incomplete edits; never sampled values. */
export interface MeasurementDefinition {
  id: string;
  kind: SpatialRelationship['kind'];
  source: SpatialEndpoint | null;
  target: SpatialEndpoint | null;
  vertex: SpatialEndpoint | null;
  color?: string;
  visible?: boolean;
  showDistance?: boolean;
  fullLength?: boolean;
}
export interface MeasurementLinkState { version: 1; items: MeasurementDefinition[]; selected?: string; }
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new ViewStateError(`Measurement context: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'malformed definition.');
  return value as Record<string, unknown>;
}
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 128;
function endpoint(value: unknown): SpatialEndpoint | null {
  if (value === null) return null;
  const e = object(value);
  check(e.kind === 'entity' || e.kind === 'body-fixed' || e.kind === 'coordinate', 'invalid endpoint type.');
  check(e.label === undefined || text(e.label), 'invalid endpoint label.');
  const label = e.label === undefined ? {} : { label: e.label };
  if (e.kind === 'entity') {
    check(text(e.bodyName), 'invalid entity reference.');
    return { kind: 'entity', bodyName: e.bodyName, ...label };
  }
  check(Array.isArray(e.positionKm) && e.positionKm.length === 3 && e.positionKm.every(v =>
    typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e12), 'invalid or out-of-range coordinates.');
  const positionKm = [...e.positionKm] as [number, number, number];
  if (e.kind === 'body-fixed') {
    check(text(e.bodyName), 'invalid surface reference.');
    return { kind: 'body-fixed', bodyName: e.bodyName, positionKm, ...label };
  }
  check(e.frame === undefined || text(e.frame), 'invalid coordinate frame.');
  return { kind: 'coordinate', frame: e.frame ?? 'ECLIPJ2000', positionKm, ...label };
}
/** Allowlist and validate the whole payload before any scene mutation. */
export function validateMeasurementLinkState(value: unknown): MeasurementLinkState {
  const s = object(value);
  check(s.version === 1, 'unsupported version.');
  check(Array.isArray(s.items) && s.items.length <= 32, 'share at most 32 measurements.');
  const items = s.items.map((raw): MeasurementDefinition => {
    const m = object(raw);
    check(text(m.id), 'invalid identity.');
    check(m.kind === 'distance' || m.kind === 'angle' || m.kind === 'direction', 'invalid measurement type.');
    const item: MeasurementDefinition = { id: m.id, kind: m.kind,
      source: endpoint(m.source), target: endpoint(m.target), vertex: endpoint(m.vertex) };
    if (m.color !== undefined) {
      check(typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color), 'invalid color.');
      item.color = m.color;
    }
    for (const flag of ['visible', 'showDistance', 'fullLength'] as const) {
      if (m[flag] !== undefined) { check(typeof m[flag] === 'boolean', `invalid ${flag} flag.`); item[flag] = m[flag]; }
    }
    return item;
  });
  check(new Set(items.map(m => m.id)).size === items.length, 'duplicate identity.');
  check(s.selected === undefined || (text(s.selected) && items.some(m => m.id === s.selected)), 'invalid selected identity.');
  return { version: 1, items, ...(s.selected === undefined ? {} : { selected: s.selected as string }) };
}
/** Check catalog references as a batch, after loading and before installing definitions. */
export function validateMeasurementReferences(state: MeasurementLinkState, universe: Universe, et: number): void {
  for (const item of state.items) for (const e of [item.source, item.target, item.vertex]) {
    if (!e) continue;
    if (e.kind === 'coordinate') {
      let available = false;
      try { available = !!universe.frames.rotation(e.frame!, 'ECLIPJ2000', et); } catch { /* reported below */ }
      check(available, `frame "${e.frame}" is unavailable in this catalog at the shared epoch.`);
    } else {
      const body = universe.getBody(e.bodyName);
      check(body, `body "${e.bodyName}" is unavailable in this catalog.`);
      check(e.kind !== 'body-fixed' || body.rotation, `body-fixed attitude for "${e.bodyName}" is unavailable.`);
    }
  }
}
