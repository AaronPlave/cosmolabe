import type { SpatialEndpoint, SpatialRelationship, ReferenceVector } from './spatial-relationships.js';

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
