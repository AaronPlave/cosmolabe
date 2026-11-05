import type { PluginData } from './PluginData.js';
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
  /** Changed typed products supplied by the host. Omitted keys retain their
   * previous values; scalar resources remain backward compatible. */
  onDataUpdate?(data: Readonly<Record<string, PluginData<unknown>>>): void;
  dispose?(): void;
}
