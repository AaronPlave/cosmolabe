import type { Universe } from '../Universe.js';

export interface CosmolabePlugin {
  readonly name: string;
  onUniverseLoaded?(universe: Universe): void;
  onTimeChange?(et: number, universe: Universe): void;
  /** Names of external resources the plugin consumes; the host owns subscriptions. */
  readonly resources?: readonly string[];
  /**
   * Called by the host with changed requested resources, not a complete snapshot.
   * Omitted names retain their previous values. Resource values are intentionally
   * scalar (number, boolean, or string); hosts adapt other value types before delivery.
   */
  onResourceUpdate?(resources: Record<string, number | boolean | string>): void;
  dispose?(): void;
}
