import type { SurfacePointAnchor, SurfaceDatum, FrameAxis, ReferenceVector, SpatialEndpoint, SpatialRelationship, Universe } from '@cosmolabe/core';
import { ViewStateError } from '@cosmolabe/control';

/**
 * Saved definitions, including temporarily incomplete edits; never sampled values.
 * Reference kinds reuse the endpoint slots: a velocity is of `source` relative
 * to `target` (null: its central body), and axes are drawn at `source`.
 */
export interface MeasurementDefinition {
  id: string;
  kind: SpatialRelationship['kind'];
  source: SpatialEndpoint | null;
  target: SpatialEndpoint | null;
  vertex: SpatialEndpoint | null;
  /** Axes: the frame drawn. */
  frame?: string;
  /** Angle between directions: its two operands. */
  first?: ReferenceVector | null;
  second?: ReferenceVector | null;
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
  check(e.kind === 'entity' || e.kind === 'body-fixed' || e.kind === 'coordinate' || e.kind === 'surface-point', 'invalid endpoint type.');
  check(e.label === undefined || text(e.label), 'invalid endpoint label.');
  const label = e.label === undefined ? {} : { label: e.label };
  if (e.kind === 'surface-point') {
    check(e.version === 1, 'unsupported surface-point version.');
    return { kind: 'surface-point', version: 1, point: surfacePoint(e.point), ...label };
  }
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
function number(value: unknown, limit = 1e12): number {
  check(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit, 'invalid surface value.');
  return value;
}
function positionVector(value: unknown): [number, number, number] {
  check(Array.isArray(value) && value.length === 3, 'invalid surface coordinates.');
  return value.map(v => number(v)) as [number, number, number];
}
function datum(value: unknown): SurfaceDatum {
  const d = object(value), shape = object(d.referenceShape);
  check(shape.kind === 'sphere' || shape.kind === 'ellipsoid', 'invalid reference shape.');
  const referenceShape: SurfaceDatum['referenceShape'] = shape.kind === 'sphere'
    ? { kind: 'sphere', radiusKm: number(shape.radiusKm) }
    : { kind: 'ellipsoid', radiiKm: positionVector(shape.radiiKm) };
  check(referenceShape.kind === 'sphere' ? referenceShape.radiusKm > 0 : referenceShape.radiiKm.every(r => r > 0), 'invalid reference radii.');
  check(d.verticalDatum === 'ellipsoid' || d.verticalDatum === 'reference-sphere' || d.verticalDatum === 'areoid' || d.verticalDatum === 'unknown', 'invalid vertical datum.');
  check(d.heightConvention === 'radial' || d.heightConvention === 'geodetic-normal', 'invalid height convention.');
  check(d.origin === 'terrain' || d.origin === 'body-shape', 'invalid datum origin.');
  return { referenceShape, verticalDatum: d.verticalDatum, heightConvention: d.heightConvention, origin: d.origin };
}
function surfacePoint(value: unknown): SurfacePointAnchor {
  const p = object(value), hit = object(p.hit);
  check(text(p.bodyName), 'invalid surface reference.');
  check(p.source === 'terrain' || p.source === 'surface-overlay' || p.source === 'ellipsoid' || p.source === 'mesh' || p.source === 'dsk', 'invalid surface source.');
  check(p.latitudeKind === 'geodetic' || p.latitudeKind === 'planetocentric', 'invalid latitude kind.');
  const point: SurfacePointAnchor = { bodyName: p.bodyName, bodyFixedPositionKm: positionVector(p.bodyFixedPositionKm), source: p.source,
    latDeg: number(p.latDeg, 90), lonDeg: number(p.lonDeg, 180), latitudeKind: p.latitudeKind,
    hit: { heightKm: hit.heightKm === null ? null : number(hit.heightKm), datum: hit.datum === null ? null : datum(hit.datum) } };
  check((hit.heightKm === null) === (hit.datum === null), 'inconsistent hit datum.');
  if (p.terrainSample !== undefined) {
    const t = object(p.terrainSample);
    check(text(t.sourceId) && (t.tileId === undefined || text(t.tileId)), 'invalid terrain provenance.');
    check(typeof t.describesHit === 'boolean' && t.describesHit === (p.source === 'terrain'), 'inconsistent terrain semantics.');
    point.terrainSample = { elevationKm: number(t.elevationKm), datum: datum(t.datum), sourceId: t.sourceId,
      ...(t.tileId === undefined ? {} : { tileId: t.tileId as string }), describesHit: t.describesHit };
  }
  return point;
}
const axes: readonly FrameAxis[] = ['+X', '+Y', '+Z', '-X', '-Y', '-Z'];
function vector(value: unknown): ReferenceVector | null {
  if (value === null) return null;
  const v = object(value);
  const required = (e: unknown) => { const result = endpoint(e); check(result, 'incomplete direction.'); return result; };
  if (v.kind === 'direction') return { kind: 'direction', source: required(v.source), target: required(v.target) };
  if (v.kind === 'velocity') {
    return { kind: 'velocity', object: required(v.object), ...(v.relativeTo === undefined ? {} : { relativeTo: required(v.relativeTo) }) };
  }
  check(v.kind === 'frame-axis', 'invalid direction type.');
  check(text(v.frame), 'invalid frame.');
  check(axes.includes(v.axis as FrameAxis), 'invalid frame axis.');
  return { kind: 'frame-axis', frame: v.frame, origin: required(v.origin), axis: v.axis as FrameAxis };
}
const kinds: ReadonlySet<unknown> = new Set<SpatialRelationship['kind']>(['distance', 'angle', 'direction', 'velocity', 'axes', 'vector-angle']);
/** Every endpoint a definition refers to, including those inside angle operands. */
export function definitionEndpoints(item: Pick<MeasurementDefinition, 'source' | 'target' | 'vertex' | 'first' | 'second'>): SpatialEndpoint[] {
  const ofVector = (v: ReferenceVector | null | undefined): Array<SpatialEndpoint | undefined> => !v ? []
    : v.kind === 'direction' ? [v.source, v.target] : v.kind === 'velocity' ? [v.object, v.relativeTo] : [v.origin];
  return [item.source, item.target, item.vertex, ...ofVector(item.first), ...ofVector(item.second)].filter((e): e is SpatialEndpoint => !!e);
}
function definitionFrames(item: MeasurementDefinition): string[] {
  const frames = definitionEndpoints(item).flatMap(e => e.kind === 'coordinate' ? [e.frame ?? 'ECLIPJ2000'] : []);
  if (item.kind === 'axes' && item.frame) frames.push(item.frame);
  for (const v of [item.first, item.second]) if (v?.kind === 'frame-axis') frames.push(v.frame);
  return frames;
}
/** Allowlist and validate the whole payload before any scene mutation. */
export function validateMeasurementLinkState(value: unknown): MeasurementLinkState {
  const s = object(value);
  check(s.version === 1, 'unsupported version.');
  check(Array.isArray(s.items) && s.items.length <= 32, 'share at most 32 measurements.');
  const items = s.items.map((raw): MeasurementDefinition => {
    const m = object(raw);
    check(text(m.id), 'invalid identity.');
    check(kinds.has(m.kind), 'invalid measurement type.');
    const item: MeasurementDefinition = { id: m.id, kind: m.kind as MeasurementDefinition['kind'],
      source: endpoint(m.source), target: endpoint(m.target), vertex: endpoint(m.vertex) };
    if (m.frame !== undefined) { check(text(m.frame), 'invalid frame.'); item.frame = m.frame; }
    for (const slot of ['first', 'second'] as const) if (m[slot] !== undefined) item[slot] = vector(m[slot]);
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
  for (const item of state.items) {
    for (const frame of definitionFrames(item)) {
      let available = false;
      try { available = !!universe.frames.rotation(frame, 'ECLIPJ2000', et); } catch { /* reported below */ }
      check(available, `frame "${frame}" is unavailable in this catalog at the shared epoch.`);
    }
    for (const e of definitionEndpoints(item)) {
      if (e.kind === 'coordinate') continue;
      const bodyName = e.kind === 'surface-point' ? e.point.bodyName : e.bodyName;
      const body = universe.getBody(bodyName);
      check(body, `body "${bodyName}" is unavailable in this catalog.`);
      check(e.kind === 'entity' || body.rotation, `body-fixed attitude for "${bodyName}" is unavailable.`);
    }
  }
}
