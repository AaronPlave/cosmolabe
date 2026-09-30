import type { Universe } from '../Universe.js';
import { bodyFixedOffsetToWorld } from '../kinematics.js';
import type { Vec3 } from '../spice-injection.js';
import type { Quaternion } from '../rotations/RotationModel.js';

/** A durable reference to a position, rather than a position captured from a rendered frame. */
export type SpatialEndpoint =
  | { kind: 'entity'; bodyName: string; label?: string }
  | { kind: 'body-fixed'; bodyName: string; positionKm: Vec3; label?: string }
  | { kind: 'coordinate'; positionKm: Vec3; frame?: string; label?: string };

export type SpatialRelationship =
  | { id: string; kind: 'distance'; source: SpatialEndpoint; target: SpatialEndpoint; visible?: boolean; color?: string }
  | { id: string; kind: 'direction'; source: SpatialEndpoint; target: SpatialEndpoint; visible?: boolean; color?: string; showDistance?: boolean }
  | { id: string; kind: 'angle'; source: SpatialEndpoint; vertex: SpatialEndpoint; target: SpatialEndpoint; visible?: boolean; color?: string };

export interface ResolvedSpatialRelationship {
  relationship: SpatialRelationship;
  source: Vec3;
  target: Vec3;
  vertex?: Vec3;
  distanceKm?: number;
  angleDeg?: number;
}

export function endpointLabel(endpoint: SpatialEndpoint): string {
  if (endpoint.label) return endpoint.label;
  if (endpoint.kind === 'entity') return endpoint.bodyName;
  if (endpoint.kind === 'body-fixed') return `${endpoint.bodyName} surface point`;
  return endpoint.frame ? `${endpoint.frame} coordinate` : 'World coordinate';
}

/** Resolve every endpoint into Cosmolabe's world frame at `et`. */
export function resolveSpatialEndpoint(universe: Universe, endpoint: SpatialEndpoint, et: number): Vec3 | null {
  if (endpoint.kind === 'entity') {
    return universe.getBody(endpoint.bodyName) ? universe.absolutePositionOf(endpoint.bodyName, et) : null;
  }
  if (endpoint.kind === 'coordinate') {
    const frame = endpoint.frame ?? 'ECLIPJ2000';
    try {
      const matrix = universe.frames.rotation(frame, 'ECLIPJ2000', et);
      return matrix ? [
        matrix[0] * endpoint.positionKm[0] + matrix[1] * endpoint.positionKm[1] + matrix[2] * endpoint.positionKm[2],
        matrix[3] * endpoint.positionKm[0] + matrix[4] * endpoint.positionKm[1] + matrix[5] * endpoint.positionKm[2],
        matrix[6] * endpoint.positionKm[0] + matrix[7] * endpoint.positionKm[1] + matrix[8] * endpoint.positionKm[2],
      ] : endpoint.positionKm;
    } catch { return null; }
  }
  const body = universe.getBody(endpoint.bodyName);
  if (!body) return null;
  const center = universe.absolutePositionOf(body.name, et);
  const rotation = body.rotation;
  if (!rotation) return [center[0] + endpoint.positionKm[0], center[1] + endpoint.positionKm[1], center[2] + endpoint.positionKm[2]];
  const q = rotation.rotationAt(et);
  const worldOffset = q ? bodyFixedVectorToWorld(endpoint.positionKm, q, rotation.sourceFrame, et, universe) : endpoint.positionKm;
  return [center[0] + worldOffset[0], center[1] + worldOffset[1], center[2] + worldOffset[2]];
}

function bodyFixedVectorToWorld(position: Vec3, q: Quaternion, sourceFrame: string, et: number, universe: Universe): Vec3 {
  // Reuse the latitude/longitude helper without losing the exact picked radius.
  const r = Math.hypot(...position);
  if (r === 0) return [0, 0, 0];
  const lat = Math.asin(position[2] / r) * 180 / Math.PI;
  const lon = Math.atan2(position[1], position[0]) * 180 / Math.PI;
  return bodyFixedOffsetToWorld(r, lat, lon, q, sourceFrame, 'ECLIPJ2000', et, universe.frames);
}

export function resolveSpatialRelationship(universe: Universe, relationship: SpatialRelationship, et: number): ResolvedSpatialRelationship | null {
  const source = resolveSpatialEndpoint(universe, relationship.source, et);
  const target = resolveSpatialEndpoint(universe, relationship.target, et);
  if (!source || !target) return null;
  if (relationship.kind !== 'angle') {
    return { relationship, source, target, distanceKm: distance(source, target) };
  }
  const vertex = resolveSpatialEndpoint(universe, relationship.vertex, et);
  if (!vertex) return null;
  const a: Vec3 = [source[0] - vertex[0], source[1] - vertex[1], source[2] - vertex[2]];
  const b: Vec3 = [target[0] - vertex[0], target[1] - vertex[1], target[2] - vertex[2]];
  const denominator = Math.hypot(...a) * Math.hypot(...b);
  const angleDeg = denominator === 0 ? 0 : Math.acos(Math.max(-1, Math.min(1, (a[0]*b[0]+a[1]*b[1]+a[2]*b[2]) / denominator))) * 180 / Math.PI;
  return { relationship, source, target, vertex, angleDeg };
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function formatSpatialDistance(km: number): string {
  if (km >= 149_597_870.7) return `${(km / 149_597_870.7).toFixed(3)} AU`;
  if (km < 1) return `${(km * 1000).toFixed(km < 0.01 ? 1 : 0)} m`;
  return `${km.toLocaleString(undefined, { maximumFractionDigits: km < 100 ? 2 : 0 })} km`;
}
