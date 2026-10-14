import type { Universe } from '../Universe.js';
import { bodyFixedOffsetToWorld } from '../kinematics.js';
import type { Vec3 } from '../spice-injection.js';
import type { Quaternion } from '../rotations/RotationModel.js';
import { WORLD_FRAME, bodyFixedFrameName } from '../frames/FrameRegistry.js';

/** A durable reference to a position, rather than a position captured from a rendered frame. */
export type SpatialEndpoint =
  | { kind: 'entity'; bodyName: string; label?: string }
  | { kind: 'body-fixed'; bodyName: string; positionKm: Vec3; label?: string }
  | { kind: 'coordinate'; positionKm: Vec3; frame?: string; label?: string };

export type FrameAxis = '+X' | '+Y' | '+Z' | '-X' | '-Y' | '-Z';

/**
 * A direction-valued analytical quantity, anchored where it applies. These are
 * the operands of a `vector-angle`; each also has a displayable relationship
 * of its own (`direction`, `velocity`, one axis of `axes`).
 */
export type ReferenceVector =
  | { kind: 'direction'; source: SpatialEndpoint; target: SpatialEndpoint }
  /** Inertial velocity of `object` relative to `relativeTo` (default: its central body). */
  | { kind: 'velocity'; object: SpatialEndpoint; relativeTo?: SpatialEndpoint }
  | { kind: 'frame-axis'; frame: string; origin: SpatialEndpoint; axis: FrameAxis };

/** Presentation state. It never changes what a relationship resolves to. */
interface Presentation { id: string; visible?: boolean; color?: string; emphasized?: boolean; selected?: boolean; hovered?: boolean; editing?: boolean }

/**
 * Measurements and analytical reference geometry share one semantic model:
 * renderers and readouts consume what `resolveSpatialRelationship` returns,
 * never state of their own.
 */
export type SpatialRelationship =
  | Presentation & { kind: 'distance'; source: SpatialEndpoint; target: SpatialEndpoint }
  | Presentation & { kind: 'direction'; source: SpatialEndpoint; target: SpatialEndpoint; showDistance?: boolean; fullLength?: boolean }
  | Presentation & { kind: 'angle'; source: SpatialEndpoint; vertex: SpatialEndpoint; target: SpatialEndpoint }
  | Presentation & { kind: 'velocity'; object: SpatialEndpoint; relativeTo?: SpatialEndpoint }
  /** The axes of any frame the frame registry resolves, drawn at `origin`. */
  | Presentation & { kind: 'axes'; frame: string; origin: SpatialEndpoint }
  /** The angle between two directions, compared at the first one's origin. */
  | Presentation & { kind: 'vector-angle'; first: ReferenceVector; second: ReferenceVector };

type Of<K extends SpatialRelationship['kind']> = Extract<SpatialRelationship, { kind: K }>;

export interface ResolvedReferenceVector {
  origin: Vec3;
  /** World-frame unit vector, or null when the quantity has zero length. */
  direction: Vec3 | null;
  /** km for a direction, km/s for a velocity; a frame axis has no magnitude. */
  magnitude?: number;
  /** The body a velocity is relative to, after defaulting. */
  center?: SpatialEndpoint;
}

export type ResolvedSpatialRelationship =
  | { kind: 'distance'; relationship: Of<'distance'>; source: Vec3; target: Vec3; distanceKm: number }
  | { kind: 'direction'; relationship: Of<'direction'>; source: Vec3; target: Vec3; distanceKm: number }
  | { kind: 'angle'; relationship: Of<'angle'>; source: Vec3; vertex: Vec3; target: Vec3; angleDeg?: number }
  | { kind: 'velocity'; relationship: Of<'velocity'>; origin: Vec3; velocityKmS: Vec3; speedKmS: number; direction: Vec3 | null; center?: SpatialEndpoint }
  /** World-frame unit X, Y and Z axes of the frame. */
  | { kind: 'axes'; relationship: Of<'axes'>; origin: Vec3; axes: [Vec3, Vec3, Vec3] }
  | { kind: 'vector-angle'; relationship: Of<'vector-angle'>; vertex: Vec3; first: ResolvedReferenceVector; second: ResolvedReferenceVector; angleDeg?: number };

type ResolvedFor<R extends SpatialRelationship> = Extract<ResolvedSpatialRelationship, { kind: R['kind'] }>;

export function endpointLabel(endpoint: SpatialEndpoint): string {
  if (endpoint.label) return endpoint.label;
  if (endpoint.kind === 'entity') return endpoint.bodyName;
  if (endpoint.kind === 'body-fixed') return `${endpoint.bodyName} point (${endpoint.positionKm.map(v => v.toFixed(2)).join(", ")} km)`;
  return endpoint.frame ? `${endpoint.frame} coordinate` : 'World coordinate';
}

/** Resolve every endpoint into Cosmolabe's world frame at `et`. */
export function resolveSpatialEndpoint(universe: Universe, endpoint: SpatialEndpoint, et: number): Vec3 | null {
  const finite = (position: Vec3): Vec3 | null => position.every(Number.isFinite) ? position : null;
  if (endpoint.kind === 'entity') {
    if (!universe.getBody(endpoint.bodyName)) return null;
    try { return finite(universe.absolutePositionOf(endpoint.bodyName, et)); } catch { return null; }
  }
  if (endpoint.kind === 'coordinate') {
    const frame = endpoint.frame ?? 'ECLIPJ2000';
    try {
      const matrix = universe.frames.rotation(frame, 'ECLIPJ2000', et);
      if (!matrix) return null;
      return finite([
        matrix[0] * endpoint.positionKm[0] + matrix[1] * endpoint.positionKm[1] + matrix[2] * endpoint.positionKm[2],
        matrix[3] * endpoint.positionKm[0] + matrix[4] * endpoint.positionKm[1] + matrix[5] * endpoint.positionKm[2],
        matrix[6] * endpoint.positionKm[0] + matrix[7] * endpoint.positionKm[1] + matrix[8] * endpoint.positionKm[2],
      ]);
    } catch { return null; }
  }
  const body = universe.getBody(endpoint.bodyName);
  if (!body) return null;
  try {
    const center = universe.absolutePositionOf(body.name, et);
    const rotation = body.rotation;
    // A body-fixed coordinate has no defined world position without attitude.
    if (!rotation) return null;
    const q = rotation.rotationAt(et);
    if (!q || !q.every(Number.isFinite)) return null;
    const worldOffset = bodyFixedVectorToWorld(endpoint.positionKm, q, rotation.sourceFrame, et, universe);
    return finite([center[0] + worldOffset[0], center[1] + worldOffset[1], center[2] + worldOffset[2]]);
  } catch { return null; }
}

function bodyFixedVectorToWorld(position: Vec3, q: Quaternion, sourceFrame: string, et: number, universe: Universe): Vec3 {
  // Reuse the latitude/longitude helper without losing the exact picked radius.
  const r = Math.hypot(...position);
  if (r === 0) return [0, 0, 0];
  const lat = Math.asin(position[2] / r) * 180 / Math.PI;
  const lon = Math.atan2(position[1], position[0]) * 180 / Math.PI;
  return bodyFixedOffsetToWorld(r, lat, lon, q, sourceFrame, 'ECLIPJ2000', et, universe.frames);
}

export function resolveSpatialRelationship<R extends SpatialRelationship>(universe: Universe, relationship: R, et: number): ResolvedFor<R> | null {
  return resolveAny(universe, relationship, et) as ResolvedFor<R> | null;
}

function resolveAny(universe: Universe, relationship: SpatialRelationship, et: number): ResolvedSpatialRelationship | null {
  switch (relationship.kind) {
    case 'distance': case 'direction': {
      const source = resolveSpatialEndpoint(universe, relationship.source, et);
      const target = resolveSpatialEndpoint(universe, relationship.target, et);
      if (!source || !target) return null;
      return relationship.kind === 'distance'
        ? { kind: 'distance', relationship, source, target, distanceKm: distance(source, target) }
        : { kind: 'direction', relationship, source, target, distanceKm: distance(source, target) };
    }
    case 'angle': {
      const source = resolveSpatialEndpoint(universe, relationship.source, et);
      const target = resolveSpatialEndpoint(universe, relationship.target, et);
      const vertex = resolveSpatialEndpoint(universe, relationship.vertex, et);
      if (!source || !target || !vertex) return null;
      const angleDeg = angleBetween(sub(source, vertex), sub(target, vertex));
      return { kind: 'angle', relationship, source, target, vertex, angleDeg };
    }
    case 'velocity': {
      const velocity = resolveVelocity(universe, relationship.object, relationship.relativeTo, et);
      if (!velocity) return null;
      const speedKmS = Math.hypot(...velocity.velocityKmS);
      return { kind: 'velocity', relationship, origin: velocity.origin, velocityKmS: velocity.velocityKmS, speedKmS,
        direction: unit(velocity.velocityKmS), ...(velocity.center ? { center: velocity.center } : {}) };
    }
    case 'axes': {
      const origin = resolveSpatialEndpoint(universe, relationship.origin, et);
      const axes = resolveFrameAxes(universe, relationship.frame, et);
      return origin && axes ? { kind: 'axes', relationship, origin, axes } : null;
    }
    case 'vector-angle': {
      const first = resolveReferenceVector(universe, relationship.first, et);
      const second = resolveReferenceVector(universe, relationship.second, et);
      if (!first || !second) return null;
      const angleDeg = first.direction && second.direction ? angleBetween(first.direction, second.direction) : undefined;
      return { kind: 'vector-angle', relationship, vertex: first.origin, first, second, angleDeg };
    }
  }
}

/** Half of the central-difference step for velocities, in seconds. */
const VELOCITY_HALF_STEP_S = 0.5;

/**
 * The body a velocity is measured against when none is named: an entity's
 * central body at `et`, a surface point's own body. A coordinate has none,
 * so its velocity is relative to the scene origin.
 */
export function defaultVelocityCenter(universe: Universe, object: SpatialEndpoint, et: number): SpatialEndpoint | undefined {
  if (object.kind === 'body-fixed') return { kind: 'entity', bodyName: object.bodyName };
  if (object.kind !== 'entity') return undefined;
  const parent = universe.getBody(object.bodyName)?.activeParentAt(et);
  return parent && universe.getBody(parent) ? { kind: 'entity', bodyName: parent } : undefined;
}

/**
 * Inertial (scene-frame) velocity of one reference relative to another, as
 * the central difference of their resolved positions. Differencing positions
 * rather than reading a trajectory's own velocity keeps every endpoint kind
 * and frame on one rule: a ground station's velocity includes its planet's
 * rotation, and a composite arc needs no special case.
 */
export function resolveVelocity(universe: Universe, object: SpatialEndpoint, relativeTo: SpatialEndpoint | undefined, et: number): { origin: Vec3; velocityKmS: Vec3; center?: SpatialEndpoint } | null {
  const center = relativeTo ?? defaultVelocityCenter(universe, object, et);
  const relative = (t: number): Vec3 | null => {
    const p = resolveSpatialEndpoint(universe, object, t);
    if (!p) return null;
    if (!center) return p;
    const c = resolveSpatialEndpoint(universe, center, t);
    return c ? sub(p, c) : null;
  };
  const origin = resolveSpatialEndpoint(universe, object, et);
  const before = relative(et - VELOCITY_HALF_STEP_S), after = relative(et + VELOCITY_HALF_STEP_S);
  if (!origin || !before || !after) return null;
  const velocityKmS: Vec3 = [0, 1, 2].map(i => (after[i] - before[i]) / (2 * VELOCITY_HALF_STEP_S)) as Vec3;
  return { origin, velocityKmS, ...(center ? { center } : {}) };
}

/** A frame's unit X, Y and Z axes in the scene frame, through the frame registry. */
export function resolveFrameAxes(universe: Universe, frame: string, et: number): [Vec3, Vec3, Vec3] | null {
  try {
    const m = universe.frames.rotation(frame, WORLD_FRAME, et);
    if (!m || !m.every(Number.isFinite)) return null;
    // Row-major frame → world: the image of each basis vector is a column.
    return [[m[0], m[3], m[6]], [m[1], m[4], m[7]], [m[2], m[5], m[8]]];
  } catch { return null; }
}

export function resolveReferenceVector(universe: Universe, vector: ReferenceVector, et: number): ResolvedReferenceVector | null {
  if (vector.kind === 'direction') {
    const source = resolveSpatialEndpoint(universe, vector.source, et);
    const target = resolveSpatialEndpoint(universe, vector.target, et);
    if (!source || !target) return null;
    const d = sub(target, source);
    return { origin: source, direction: unit(d), magnitude: Math.hypot(...d) };
  }
  if (vector.kind === 'velocity') {
    const velocity = resolveVelocity(universe, vector.object, vector.relativeTo, et);
    if (!velocity) return null;
    return { origin: velocity.origin, direction: unit(velocity.velocityKmS), magnitude: Math.hypot(...velocity.velocityKmS),
      ...(velocity.center ? { center: velocity.center } : {}) };
  }
  const origin = resolveSpatialEndpoint(universe, vector.origin, et);
  const axes = resolveFrameAxes(universe, vector.frame, et);
  if (!origin || !axes) return null;
  const axis = axes['XYZ'.indexOf(vector.axis[1])];
  const sign = vector.axis[0] === '-' ? -1 : 1;
  return { origin, direction: [axis[0] * sign, axis[1] * sign, axis[2] * sign] };
}

/** One relationship's component directions, as `vector-angle` operands. */
export function relationshipVectors(relationship: SpatialRelationship): ReferenceVector[] {
  if (relationship.kind === 'direction') return [{ kind: 'direction', source: relationship.source, target: relationship.target }];
  if (relationship.kind === 'velocity') return [{ kind: 'velocity', object: relationship.object, ...(relationship.relativeTo ? { relativeTo: relationship.relativeTo } : {}) }];
  if (relationship.kind === 'axes') return (['+X', '+Y', '+Z'] as const).map(axis => ({ kind: 'frame-axis', frame: relationship.frame, origin: relationship.origin, axis }));
  return [];
}

export function referenceVectorLabel(vector: ReferenceVector): string {
  if (vector.kind === 'direction') return `Direction to ${endpointLabel(vector.target)} from ${endpointLabel(vector.source)}`;
  if (vector.kind === 'velocity') return `Velocity of ${endpointLabel(vector.object)}${vector.relativeTo ? ` relative to ${endpointLabel(vector.relativeTo)}` : ''}`;
  return `${vector.frame} ${vector.axis} at ${endpointLabel(vector.origin)}`;
}

/**
 * A semantic request for reference geometry — what a caller means, not how
 * it is drawn. Bodies may be named directly.
 */
export type ReferenceRequest =
  | { kind: 'direction'; from: string | SpatialEndpoint; to: string | SpatialEndpoint }
  | { kind: 'sunDirection'; object: string | SpatialEndpoint; sun?: string }
  | { kind: 'velocity'; object: string | SpatialEndpoint; relativeTo?: string | SpatialEndpoint }
  | { kind: 'frameAxes'; frame: string; origin: string | SpatialEndpoint }
  /** A body's own body-fixed axes: X the prime meridian, Z the pole. */
  | { kind: 'bodyAxes'; object: string }
  | { kind: 'angle'; first: ReferenceVector; second: ReferenceVector };

interface RequestedKinds { direction: 'direction'; sunDirection: 'direction'; velocity: 'velocity'; frameAxes: 'axes'; bodyAxes: 'axes'; angle: 'vector-angle' }

/** Translate a request into the relationship that renders and resolves it. */
export function referenceRelationship<Q extends ReferenceRequest>(request: Q, id: string): Of<RequestedKinds[Q['kind']]> {
  return requested(request, id) as Of<RequestedKinds[Q['kind']]>;
}

function requested(request: ReferenceRequest, id: string): SpatialRelationship {
  const at = (ref: string | SpatialEndpoint): SpatialEndpoint => typeof ref === 'string' ? { kind: 'entity', bodyName: ref } : ref;
  switch (request.kind) {
    case 'direction': return { id, kind: 'direction', source: at(request.from), target: at(request.to) };
    case 'sunDirection': return { id, kind: 'direction', source: at(request.object), target: at(request.sun ?? 'Sun') };
    case 'velocity': return { id, kind: 'velocity', object: at(request.object), ...(request.relativeTo ? { relativeTo: at(request.relativeTo) } : {}) };
    case 'frameAxes': return { id, kind: 'axes', frame: request.frame, origin: at(request.origin) };
    case 'bodyAxes': return { id, kind: 'axes', frame: bodyFixedFrameName(request.object), origin: at(request.object) };
    case 'angle': return { id, kind: 'vector-angle', first: request.first, second: request.second };
  }
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function unit(v: Vec3): Vec3 | null {
  const length = Math.hypot(...v);
  return length > 0 && Number.isFinite(length) ? [v[0] / length, v[1] / length, v[2] / length] : null;
}
function angleBetween(a: Vec3, b: Vec3): number | undefined {
  const denominator = Math.hypot(...a) * Math.hypot(...b);
  return denominator === 0 ? undefined : Math.acos(Math.max(-1, Math.min(1, (a[0]*b[0]+a[1]*b[1]+a[2]*b[2]) / denominator))) * 180 / Math.PI;
}
function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function formatSpatialSpeed(kmS: number): string {
  return kmS < 1 ? `${(kmS * 1000).toFixed(kmS < 0.01 ? 2 : 1)} m/s` : `${kmS.toFixed(kmS < 100 ? 3 : 1)} km/s`;
}

export function formatSpatialDistance(km: number): string {
  if (km >= 149_597_870.7) return `${(km / 149_597_870.7).toFixed(3)} AU`;
  if (km < 1) return `${(km * 1000).toFixed(km < 0.01 ? 1 : 0)} m`;
  return `${km.toLocaleString(undefined, { maximumFractionDigits: km < 100 ? 2 : 0 })} km`;
}
